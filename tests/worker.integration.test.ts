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
  requestId?: string
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (auth === "valid") {
    headers.set("authorization", `Bearer ${context.apiToken}`);
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
      const responseWithHeader = await apiRequest(context, "/tasks", { method: "GET" }, "none", customRequestId);
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
    }, "valid", requestId);
    expect(createResponse.status).toBe(201);
    const created = await readJson<{ task: { id: string; title: string; note: string | null; status: string; dueDate: string | null } }>(
      createResponse
    );
    expect(created.task.title).toBe("Write integration tests");
    expect(created.task.status).toBe("open");

    const listOpenResponse = await apiRequest(context, "/tasks?status=open&limit=50", { method: "GET" });
    expect(listOpenResponse.status).toBe(200);
    const listedOpen = await readJson<{ tasks: Array<{ id: string; title: string }> }>(listOpenResponse);
    expect(listedOpen.tasks).toHaveLength(1);
    expect(listedOpen.tasks[0]?.id).toBe(created.task.id);

    const patchResponse = await apiRequest(context, `/tasks/${created.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ note: "updated note", dueDate: "2026-04-03" })
    }, "valid", requestId);
    expect(patchResponse.status).toBe(200);
    const patched = await readJson<{ task: { note: string | null; dueDate: string | null } }>(patchResponse);
    expect(patched.task.note).toBe("updated note");
    expect(patched.task.dueDate).toBe("2026-04-03");

    const completeResponse = await apiRequest(context, `/tasks/${created.task.id}/complete`, { method: "POST" }, "valid", requestId);
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
    }, "valid", requestId);
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
    }, "valid", requestId);
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
});
