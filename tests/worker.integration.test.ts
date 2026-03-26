import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { createWorkerTestContext, type WorkerTestContext } from "./helpers/worker-test-context";

const contexts: WorkerTestContext[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (context) {
      await context.cleanup();
    }
  }
});

const newContext = async (): Promise<WorkerTestContext> => {
  const context = await createWorkerTestContext();
  contexts.push(context);
  return context;
};

const apiRequest = async (
  context: WorkerTestContext,
  pathName: string,
  init: RequestInit = {},
  auth: "valid" | "invalid" | "none" = "valid",
  tokenOverride?: string,
  requestId?: string
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (auth === "valid") {
    headers.set("authorization", `Bearer ${tokenOverride ?? context.apiToken}`);
  }
  if (auth === "invalid") {
    headers.set("authorization", "Bearer not-the-right-token");
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (requestId) {
    headers.set("x-request-id", requestId);
  }

  return worker.fetch(new Request(`http://unit.test${pathName}`, { ...init, headers }), context.env);
};

const readJson = async <T>(response: Response): Promise<T> => {
  return (await response.json()) as T;
};

const queryAuditEvents = async (
  context: WorkerTestContext
): Promise<Array<{ event_type: string; actor_user_id: string; resource_type: string; resource_id: string; request_id: string }>> => {
  const result = await context.env.DB.prepare(
    "SELECT event_type, actor_user_id, resource_type, resource_id, request_id FROM audit_events ORDER BY created_at ASC"
  ).all<{ event_type: string; actor_user_id: string; resource_type: string; resource_id: string; request_id: string }>();
  return result.results;
};

const createTask = async (
  context: WorkerTestContext,
  payload: { title: string; note?: string; dueDate?: string; listId?: string; tags?: string[] }
): Promise<{ id: string; title: string; note: string | null; dueDate: string | null; listId: string; tags: string[] }> => {
  const response = await apiRequest(context, "/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  expect(response.status).toBe(201);
  const body = await readJson<{
    task: { id: string; title: string; note: string | null; dueDate: string | null; listId: string; tags: string[] };
  }>(response);
  return body.task;
};

const createList = async (context: WorkerTestContext, name: string): Promise<string> => {
  const response = await apiRequest(context, "/lists", {
    method: "POST",
    body: JSON.stringify({ name })
  });
  expect(response.status).toBe(201);
  const body = await readJson<{ list: { id: string } }>(response);
  return body.list.id;
};

describe("worker integration", () => {
  it("enforces bearer auth for protected endpoints", async () => {
    const context = await newContext();

    const missingTokenResponse = await apiRequest(context, "/tasks", { method: "GET" }, "none");
    expect(missingTokenResponse.status).toBe(401);
    await expect(readJson<{ error: string }>(missingTokenResponse)).resolves.toEqual({ error: "missing bearer token" });

    const invalidTokenResponse = await apiRequest(context, "/tasks", { method: "GET" }, "invalid");
    expect(invalidTokenResponse.status).toBe(401);
    await expect(readJson<{ error: string }>(invalidTokenResponse)).resolves.toEqual({ error: "invalid bearer token" });
  });

  it("returns and propagates request ids in responses and auth failure logs", async () => {
    const context = await newContext();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const responseWithoutHeader = await apiRequest(context, "/tasks", { method: "GET" });
      expect(responseWithoutHeader.headers.get("x-request-id")).toMatch(/[a-f0-9-]{36}/);

      const customRequestId = "req-ctx-0001";
      const responseWithHeader = await apiRequest(context, "/tasks", { method: "GET" }, "none", undefined, customRequestId);
      expect(responseWithHeader.status).toBe(401);
      expect(responseWithHeader.headers.get("x-request-id")).toBe(customRequestId);

      const authFailureLine = warnSpy.mock.calls
        .map((call) => call[0])
        .find((value) => typeof value === "string" && value.includes('"event":"auth.failure"'));
      expect(authFailureLine).toContain(`"requestId":"${customRequestId}"`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("supports task CRUD lifecycle", async () => {
    const context = await newContext();
    const requestId = "req-audit-task-flow";

    const createResponse = await apiRequest(context, "/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Write integration tests", note: "baseline", dueDate: "2026-04-01" })
    }, "valid", undefined, requestId);
    expect(createResponse.status).toBe(201);
    const created = await readJson<{
      task: { id: string; title: string; note: string | null; status: string; dueDate: string | null; listId: string };
    }>(
      createResponse
    );
    expect(created.task.title).toBe("Write integration tests");
    expect(created.task.status).toBe("open");
    expect(created.task.listId).toBe("default:test-user");

    const listOpenResponse = await apiRequest(context, "/tasks?status=open&limit=50", { method: "GET" });
    expect(listOpenResponse.status).toBe(200);
    const listedOpen = await readJson<{ tasks: Array<{ id: string; title: string }> }>(listOpenResponse);
    expect(listedOpen.tasks).toHaveLength(1);
    expect(listedOpen.tasks[0]?.id).toBe(created.task.id);

    const patchResponse = await apiRequest(context, `/tasks/${created.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ note: "updated note", dueDate: "2026-04-03" })
    }, "valid", undefined, requestId);
    expect(patchResponse.status).toBe(200);
    const patched = await readJson<{ task: { note: string | null; dueDate: string | null } }>(patchResponse);
    expect(patched.task.note).toBe("updated note");
    expect(patched.task.dueDate).toBe("2026-04-03");

    const completeResponse = await apiRequest(
      context,
      `/tasks/${created.task.id}/complete`,
      { method: "POST" },
      "valid",
      undefined,
      requestId
    );
    expect(completeResponse.status).toBe(200);
    const completed = await readJson<{ task: { status: string; completedAt: string | null } }>(completeResponse);
    expect(completed.task.status).toBe("done");
    expect(completed.task.completedAt).not.toBeNull();

    const listDoneResponse = await apiRequest(context, "/tasks?status=done&limit=50", { method: "GET" });
    expect(listDoneResponse.status).toBe(200);
    const listedDone = await readJson<{ tasks: Array<{ id: string; status: string }> }>(listDoneResponse);
    expect(listedDone.tasks).toHaveLength(1);
    expect(listedDone.tasks[0]?.id).toBe(created.task.id);
    expect(listedDone.tasks[0]?.status).toBe("done");

    const auditEvents = await queryAuditEvents(context);
    expect(auditEvents.map((row) => row.event_type)).toEqual(["task.created", "task.updated", "task.completed"]);
    expect(auditEvents.every((row) => row.actor_user_id === "test-user")).toBe(true);
    expect(auditEvents.every((row) => row.resource_type === "task")).toBe(true);
    expect(auditEvents.every((row) => row.resource_id === created.task.id)).toBe(true);
    expect(auditEvents.every((row) => row.request_id === requestId)).toBe(true);
  });

  it("materializes recurrence backlog and advances next run date", async () => {
    const context = await newContext();
    const requestId = "req-audit-recurrence-flow";

    const createRuleResponse = await apiRequest(context, "/recurrence-rules", {
      method: "POST",
      body: JSON.stringify({
        titleTemplate: "Daily recurring",
        noteTemplate: "autogenerated",
        cadence: "daily",
        interval: 1,
        anchorDate: "2026-01-01"
      })
    }, "valid", undefined, requestId);
    expect(createRuleResponse.status).toBe(201);
    const createRuleBody = await readJson<{ recurrenceRule: { id: string; nextRunDate: string } }>(createRuleResponse);
    expect(createRuleBody.recurrenceRule.nextRunDate).toBe("2026-01-01");

    const firstMaterialize = await apiRequest(context, "/jobs/materialize-recurrence", {
      method: "POST",
      body: JSON.stringify({ date: "2026-01-03" })
    });
    expect(firstMaterialize.status).toBe(200);
    const firstMaterializeBody = await readJson<{ ok: boolean; created: number; rulesProcessed: number }>(firstMaterialize);
    expect(firstMaterializeBody).toEqual({ ok: true, created: 3, rulesProcessed: 1 });

    const listAllTasksResponse = await apiRequest(context, "/tasks?status=all&limit=50", { method: "GET" });
    expect(listAllTasksResponse.status).toBe(200);
    const listAllTasksBody = await readJson<{
      tasks: Array<{ dueDate: string | null; recurrenceRuleId: string | null; title: string; note: string | null }>;
    }>(listAllTasksResponse);
    expect(listAllTasksBody.tasks).toHaveLength(3);
    expect(listAllTasksBody.tasks.map((task) => task.dueDate)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(listAllTasksBody.tasks.every((task) => task.recurrenceRuleId === createRuleBody.recurrenceRule.id)).toBe(true);

    const listRulesResponse = await apiRequest(context, "/recurrence-rules", { method: "GET" });
    expect(listRulesResponse.status).toBe(200);
    const listRulesBody = await readJson<{ recurrenceRules: Array<{ id: string; nextRunDate: string }> }>(listRulesResponse);
    expect(listRulesBody.recurrenceRules[0]?.id).toBe(createRuleBody.recurrenceRule.id);
    expect(listRulesBody.recurrenceRules[0]?.nextRunDate).toBe("2026-01-04");

    const secondMaterialize = await apiRequest(context, "/jobs/materialize-recurrence", {
      method: "POST",
      body: JSON.stringify({ date: "2026-01-03" })
    });
    expect(secondMaterialize.status).toBe(200);
    const secondMaterializeBody = await readJson<{ ok: boolean; created: number; rulesProcessed: number }>(secondMaterialize);
    expect(secondMaterializeBody).toEqual({ ok: true, created: 0, rulesProcessed: 0 });

    const updateRuleResponse = await apiRequest(context, `/recurrence-rules/${createRuleBody.recurrenceRule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: false })
    }, "valid", undefined, requestId);
    expect(updateRuleResponse.status).toBe(200);

    const auditEvents = await queryAuditEvents(context);
    expect(auditEvents.some((row) => row.event_type === "recurrence_rule.created")).toBe(true);
    expect(auditEvents.some((row) => row.event_type === "recurrence_rule.updated")).toBe(true);
    expect(
      auditEvents.some(
        (row) =>
          row.resource_type === "recurrence_rule" &&
          row.resource_id === createRuleBody.recurrenceRule.id &&
          row.request_id === requestId
      )
    ).toBe(true);
  });

  it("supports list creation and owner-managed memberships", async () => {
    const context = await newContext();
    await context.createUserToken({ userId: "editor-user", token: "editor-token" });

    const createListResponse = await apiRequest(context, "/lists", {
      method: "POST",
      body: JSON.stringify({ name: "House" })
    });
    expect(createListResponse.status).toBe(201);
    const createListBody = await readJson<{ list: { id: string; name: string; myRole: string } }>(createListResponse);
    expect(createListBody.list.name).toBe("House");
    expect(createListBody.list.myRole).toBe("owner");

    const ownerCanAddMembership = await apiRequest(context, `/lists/${createListBody.list.id}/memberships/editor-user`, {
      method: "PUT",
      body: JSON.stringify({ role: "editor" })
    });
    expect(ownerCanAddMembership.status).toBe(200);

    const editorMembershipsResponse = await apiRequest(
      context,
      `/lists/${createListBody.list.id}/memberships`,
      { method: "GET" },
      "valid",
      "editor-token"
    );
    expect(editorMembershipsResponse.status).toBe(200);
    const editorMemberships = await readJson<{ memberships: Array<{ userId: string; role: string }> }>(
      editorMembershipsResponse
    );
    expect(editorMemberships.memberships.map((membership) => ({ userId: membership.userId, role: membership.role }))).toEqual(
      expect.arrayContaining([
        { userId: "test-user", role: "owner" },
        { userId: "editor-user", role: "editor" }
      ])
    );

    const editorCannotWriteMembership = await apiRequest(
      context,
      `/lists/${createListBody.list.id}/memberships/test-user`,
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" })
      },
      "valid",
      "editor-token"
    );
    expect(editorCannotWriteMembership.status).toBe(403);
    await expect(readJson<{ error: string }>(editorCannotWriteMembership)).resolves.toEqual({
      error: "insufficient list role"
    });
  });

  it("enforces list isolation and editor/viewer role checks", async () => {
    const context = await newContext();
    await context.createUserToken({ userId: "editor-user", token: "editor-token" });
    await context.createUserToken({ userId: "viewer-user", token: "viewer-token" });

    const createListResponse = await apiRequest(context, "/lists", {
      method: "POST",
      body: JSON.stringify({ name: "Shared" })
    });
    const createListBody = await readJson<{ list: { id: string } }>(createListResponse);

    await apiRequest(context, `/lists/${createListBody.list.id}/memberships/editor-user`, {
      method: "PUT",
      body: JSON.stringify({ role: "editor" })
    });
    await apiRequest(context, `/lists/${createListBody.list.id}/memberships/viewer-user`, {
      method: "PUT",
      body: JSON.stringify({ role: "viewer" })
    });

    const editorCreatesTask = await apiRequest(
      context,
      "/tasks",
      {
        method: "POST",
        body: JSON.stringify({ title: "shared task", listId: createListBody.list.id })
      },
      "valid",
      "editor-token"
    );
    expect(editorCreatesTask.status).toBe(201);
    const editorTaskBody = await readJson<{ task: { id: string } }>(editorCreatesTask);

    const viewerListsTasks = await apiRequest(
      context,
      `/tasks?status=all&listId=${createListBody.list.id}`,
      { method: "GET" },
      "valid",
      "viewer-token"
    );
    expect(viewerListsTasks.status).toBe(200);
    const viewerTasksBody = await readJson<{ tasks: Array<{ id: string }> }>(viewerListsTasks);
    expect(viewerTasksBody.tasks).toHaveLength(1);
    expect(viewerTasksBody.tasks[0]?.id).toBe(editorTaskBody.task.id);

    const viewerCannotCompleteTask = await apiRequest(
      context,
      `/tasks/${editorTaskBody.task.id}/complete`,
      { method: "POST" },
      "valid",
      "viewer-token"
    );
    expect(viewerCannotCompleteTask.status).toBe(403);

    const editorCreatesRule = await apiRequest(
      context,
      "/recurrence-rules",
      {
        method: "POST",
        body: JSON.stringify({
          titleTemplate: "shared recurring",
          cadence: "daily",
          listId: createListBody.list.id,
          anchorDate: "2026-02-01"
        })
      },
      "valid",
      "editor-token"
    );
    expect(editorCreatesRule.status).toBe(201);

    const viewerCannotUpdateRule = await apiRequest(
      context,
      `/recurrence-rules/${(await readJson<{ recurrenceRule: { id: string } }>(editorCreatesRule)).recurrenceRule.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ timezone: "UTC" })
      },
      "valid",
      "viewer-token"
    );
    expect(viewerCannotUpdateRule.status).toBe(403);
  });

  it("filters tasks by search text", async () => {
    const context = await newContext();

    await createTask(context, { title: "Plan sprint", note: "alpha launch", dueDate: "2026-04-01" });
    await createTask(context, { title: "Write docs", note: "Beta users", dueDate: "2026-04-02" });

    const response = await apiRequest(context, "/tasks?status=all&search=ALPHA", { method: "GET" });
    expect(response.status).toBe(200);
    const body = await readJson<{ tasks: Array<{ title: string }> }>(response);
    expect(body.tasks.map((task) => task.title)).toEqual(["Plan sprint"]);
  });

  it("supports lightweight tags for user and agent task views", async () => {
    const context = await newContext();

    const userTask = await createTask(context, { title: "Review roadmap", tags: ["owner:user", "project:todos"] });
    await createTask(context, { title: "Sync snapshot", tags: ["owner:agent", "project:todos"] });

    const userTagResponse = await apiRequest(context, "/tasks?status=all&tag=owner:user", { method: "GET" });
    expect(userTagResponse.status).toBe(200);
    const userTagBody = await readJson<{ tasks: Array<{ id: string; tags: string[] }> }>(userTagResponse);
    expect(userTagBody.tasks).toHaveLength(1);
    expect(userTagBody.tasks[0]?.id).toBe(userTask.id);
    expect(userTagBody.tasks[0]?.tags).toEqual(["owner:user", "project:todos"]);

    const projectTagResponse = await apiRequest(context, "/tasks?status=all&tag=project:todos", { method: "GET" });
    expect(projectTagResponse.status).toBe(200);
    const projectTagBody = await readJson<{ tasks: Array<{ id: string }> }>(projectTagResponse);
    expect(projectTagBody.tasks).toHaveLength(2);
  });

  it("filters tasks by due-before and due-after", async () => {
    const context = await newContext();

    await createTask(context, { title: "Task A", dueDate: "2026-04-01" });
    await createTask(context, { title: "Task B", dueDate: "2026-04-05" });
    await createTask(context, { title: "Task C", dueDate: "2026-04-10" });

    const dueBeforeResponse = await apiRequest(context, "/tasks?status=all&due-before=2026-04-05", { method: "GET" });
    expect(dueBeforeResponse.status).toBe(200);
    const dueBeforeBody = await readJson<{ tasks: Array<{ title: string }> }>(dueBeforeResponse);
    expect(dueBeforeBody.tasks.map((task) => task.title)).toEqual(["Task A", "Task B"]);

    const dueAfterResponse = await apiRequest(context, "/tasks?status=all&due-after=2026-04-05", { method: "GET" });
    expect(dueAfterResponse.status).toBe(200);
    const dueAfterBody = await readJson<{ tasks: Array<{ title: string }> }>(dueAfterResponse);
    expect(dueAfterBody.tasks.map((task) => task.title)).toEqual(["Task B", "Task C"]);
  });

  it("filters tasks by list_id", async () => {
    const context = await newContext();

    const inboxListId = await createList(context, "Inbox List");
    const workListId = await createList(context, "Work List");

    await createTask(context, { title: "Inbox item", listId: inboxListId, dueDate: "2026-04-01" });
    await createTask(context, { title: "Work item", listId: workListId, dueDate: "2026-04-02" });

    const response = await apiRequest(context, `/tasks?status=all&list_id=${encodeURIComponent(workListId)}`, {
      method: "GET"
    });
    expect(response.status).toBe(200);
    const body = await readJson<{ tasks: Array<{ title: string; listId: string }> }>(response);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.title).toBe("Work item");
    expect(body.tasks[0]?.listId).toBe(workListId);
  });

  it("supports stable task sort options", async () => {
    const context = await newContext();

    await createTask(context, { title: "First", dueDate: "2026-04-01" });
    await createTask(context, { title: "Second", dueDate: "2026-04-03" });
    await createTask(context, { title: "Third", dueDate: "2026-04-02" });

    const dueDescResponse = await apiRequest(context, "/tasks?status=all&sort=due_date_desc", { method: "GET" });
    expect(dueDescResponse.status).toBe(200);
    const dueDescBody = await readJson<{ tasks: Array<{ title: string }> }>(dueDescResponse);
    expect(dueDescBody.tasks.map((task) => task.title)).toEqual(["Second", "Third", "First"]);

    const createdAscResponse = await apiRequest(context, "/tasks?status=all&sort=created_at_asc", { method: "GET" });
    expect(createdAscResponse.status).toBe(200);
    const createdAscBody = await readJson<{ tasks: Array<{ title: string }> }>(createdAscResponse);
    expect(createdAscBody.tasks.map((task) => task.title)).toEqual(["First", "Second", "Third"]);
  });

  it("combines status, search, list_id, date window, sort, limit, and offset", async () => {
    const context = await newContext();
    const workListId = await createList(context, "Work");
    const personalListId = await createList(context, "Personal");

    const alphaA = await createTask(context, {
      title: "Alpha A",
      note: "priority",
      dueDate: "2026-04-01",
      listId: workListId
    });
    await createTask(context, {
      title: "Alpha B",
      note: "priority",
      dueDate: "2026-04-02",
      listId: workListId
    });
    const alphaC = await createTask(context, {
      title: "Alpha C",
      note: "priority",
      dueDate: "2026-04-03",
      listId: workListId
    });
    await createTask(context, {
      title: "Beta D",
      note: "priority",
      dueDate: "2026-04-02",
      listId: workListId
    });
    await createTask(context, {
      title: "Alpha E",
      note: "priority",
      dueDate: "2026-04-02",
      listId: personalListId
    });

    await apiRequest(context, `/tasks/${encodeURIComponent(alphaA.id)}/complete`, { method: "POST" });
    await apiRequest(context, `/tasks/${encodeURIComponent(alphaC.id)}/complete`, { method: "POST" });

    const response = await apiRequest(
      context,
      `/tasks?status=done&search=alpha&list_id=${encodeURIComponent(workListId)}&due-after=2026-04-02&due-before=2026-04-03&sort=due_date_desc&limit=10&offset=0`,
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ tasks: Array<{ id: string; title: string; status: string; listId: string }> }>(response);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.id).toBe(alphaC.id);
    expect(body.tasks[0]?.title).toBe("Alpha C");
    expect(body.tasks[0]?.status).toBe("done");
    expect(body.tasks[0]?.listId).toBe(workListId);
  });
});
