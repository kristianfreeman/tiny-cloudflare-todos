import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

const runCliSyncAgent = async (apiUrl: string, token: string, outPath: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmExecutable, ["run", "cli", "--", "sync-agent", "--out", outPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TODO_API_URL: apiUrl,
        TODO_API_TOKEN: token
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sync-agent command failed with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
};

const tempPaths: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPaths.splice(0, tempPaths.length)) {
    await rm(tempPath, { recursive: true, force: true });
  }
});

describe("sync-agent integration", () => {
  it("writes deterministic snapshot shape", async () => {
    const token = "sync-token";

    const server = createServer((request, response) => {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "invalid bearer token" }));
        return;
      }

      if (!request.url) {
        response.statusCode = 404;
        response.end();
        return;
      }

      if (request.url.startsWith("/tasks")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            tasks: [
              {
                id: "task-z",
                title: "No due date",
                note: "later",
                tags: ["owner:agent"],
                status: "open",
                dueDate: null,
                recurrenceRuleId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                completedAt: null
              },
              {
                id: "task-a",
                title: "Due first",
                note: null,
                tags: ["owner:user", "project:home"],
                status: "open",
                dueDate: "2026-03-01",
                recurrenceRuleId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                completedAt: null
              },
              {
                id: "task-done",
                title: "Finished",
                note: null,
                tags: ["owner:user"],
                status: "done",
                dueDate: "2026-02-20",
                recurrenceRuleId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                completedAt: "2026-02-20T09:10:11.000Z"
              },
              {
                id: "task-b",
                title: "Due second",
                note: "alpha",
                tags: [],
                status: "open",
                dueDate: "2026-03-01",
                recurrenceRuleId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                completedAt: null
              }
            ]
          })
        );
        return;
      }

      if (request.url.startsWith("/recurrence-rules")) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            recurrenceRules: [
              {
                id: "rule-b",
                titleTemplate: "Rule B",
                noteTemplate: null,
                cadence: "weekly",
                interval: 1,
                weekdays: [1, 3, 5],
                timezone: "UTC",
                anchorDate: "2026-01-01",
                nextRunDate: "2026-03-02",
                exceptionDates: null,
                active: true,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z"
              },
              {
                id: "rule-a",
                titleTemplate: "Rule A",
                noteTemplate: "template",
                cadence: "daily",
                interval: 2,
                weekdays: null,
                timezone: "UTC",
                anchorDate: "2026-01-01",
                nextRunDate: "2026-03-01",
                exceptionDates: null,
                active: true,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z"
              }
            ]
          })
        );
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to determine mock API port");
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "tiny-cloudflare-todos-cli-test-"));
    tempPaths.push(tempDir);
    const outPath = path.join(tempDir, "snapshot.md");

    try {
      await runCliSyncAgent(`http://127.0.0.1:${String(address.port)}`, token, outPath);
    } finally {
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

    const snapshot = await readFile(outPath, "utf8");
    expect(snapshot).toBe(`# Deterministic Todo Snapshot

## Open Tasks
- task-a | Due first | due:2026-03-01 | note:
  tags:owner:user,project:home
- task-b | Due second | due:2026-03-01 | note:alpha
  tags:none
- task-z | No due date | due:none | note:later
  tags:owner:agent

## Done Tasks
- task-done | Finished | done:2026-02-20T09:10:11.000Z

## Recurrence Rules
- rule-a | Rule A | cadence:daily | interval:2 | weekdays:none | dayOfMonth:none | timezone:UTC | skip:none | next:2026-03-01
- rule-b | Rule B | cadence:weekly | interval:1 | weekdays:1,3,5 | dayOfMonth:none | timezone:UTC | skip:none | next:2026-03-02
`);
  });
});
