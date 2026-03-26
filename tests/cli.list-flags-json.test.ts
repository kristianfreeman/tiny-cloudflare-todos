import { createServer } from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (args: string[], apiUrl: string, token: string): Promise<CliResult> => {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(npmExecutable, ["run", "-s", "cli", "--", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TODO_API_URL: apiUrl,
        TODO_API_TOKEN: token
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

describe("cli list json and filter flags", () => {
  it("rejects invalid due-before date format", async () => {
    const result = await runCli(["list", "--due-before", "03-01-2026"], "http://127.0.0.1:9999", "token");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--due-before must be YYYY-MM-DD");
  });

  it("outputs task list as JSON and passes filter query params", async () => {
    const token = "list-token";
    const seenTaskUrls: string[] = [];

    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "invalid bearer token" }));
        return;
      }

      const url = request.url ?? "";
      if (url.startsWith("/tasks")) {
        seenTaskUrls.push(url);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            tasks: [
              {
                id: "task-1",
                title: "Pay rent",
                note: "bank transfer",
                tags: ["owner:user", "project:finance"],
                status: "open",
                dueDate: "2026-03-28",
                recurrenceRuleId: null,
                createdAt: "2026-03-01T00:00:00.000Z",
                updatedAt: "2026-03-01T00:00:00.000Z",
                completedAt: null
              }
            ]
          })
        );
        return;
      }

      if (url.startsWith("/recurrence-rules")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ recurrenceRules: [] }));
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to determine mock API port");
    }

    const result = await runCli(
      [
        "list",
        "--status",
        "all",
        "--list-id",
        "backlog",
        "--due-before",
        "2026-04-01",
        "--due-after",
        "2026-03-01",
        "--search",
        "rent",
        "--sort",
        "due_date:asc",
        "--tag",
        "owner:user",
        "--json"
      ],
      `http://127.0.0.1:${String(address.port)}`,
      token
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(seenTaskUrls).toHaveLength(1);

    const requestUrl = new URL(seenTaskUrls[0] ?? "", "http://unit.test");
    expect(requestUrl.searchParams.get("status")).toBe("all");
    expect(requestUrl.searchParams.get("limit")).toBe("200");
    expect(requestUrl.searchParams.get("list_id")).toBe("backlog");
    expect(requestUrl.searchParams.get("due_before")).toBe("2026-04-01");
    expect(requestUrl.searchParams.get("due_after")).toBe("2026-03-01");
    expect(requestUrl.searchParams.get("search")).toBe("rent");
    expect(requestUrl.searchParams.get("sort")).toBe("due_date:asc");
    expect(requestUrl.searchParams.get("tag")).toBe("owner:user");

    const output = JSON.parse(result.stdout) as {
      tasks: Array<{ id: string; title: string; dueDate: string | null; status: string }>;
    };
    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0]?.id).toBe("task-1");
    expect(output.tasks[0]?.title).toBe("Pay rent");
  });

  it("outputs recurrence rule list as JSON", async () => {
    const token = "recur-list-token";
    const seenRuleUrls: string[] = [];

    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "invalid bearer token" }));
        return;
      }

      const url = request.url ?? "";
      if (url.startsWith("/tasks")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ tasks: [] }));
        return;
      }

      if (url.startsWith("/recurrence-rules")) {
        seenRuleUrls.push(url);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            recurrenceRules: [
              {
                id: "rule-1",
                titleTemplate: "Daily standup",
                noteTemplate: null,
                cadence: "daily",
                interval: 1,
                weekdays: null,
                timezone: "UTC",
                anchorDate: "2026-03-01",
                nextRunDate: "2026-03-26",
                exceptionDates: null,
                active: true,
                createdAt: "2026-03-01T00:00:00.000Z",
                updatedAt: "2026-03-01T00:00:00.000Z"
              }
            ]
          })
        );
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to determine mock API port");
    }

    const result = await runCli(
      ["recur-list", "--search", "standup", "--sort", "next_run_date:asc", "--json"],
      `http://127.0.0.1:${String(address.port)}`,
      token
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(seenRuleUrls).toHaveLength(1);

    const requestUrl = new URL(seenRuleUrls[0] ?? "", "http://unit.test");
    expect(requestUrl.searchParams.get("search")).toBe("standup");
    expect(requestUrl.searchParams.get("sort")).toBe("next_run_date:asc");

    const output = JSON.parse(result.stdout) as {
      recurrenceRules: Array<{ id: string; titleTemplate: string; nextRunDate: string }>;
    };
    expect(output.recurrenceRules).toHaveLength(1);
    expect(output.recurrenceRules[0]?.id).toBe("rule-1");
    expect(output.recurrenceRules[0]?.titleTemplate).toBe("Daily standup");
  });
});
