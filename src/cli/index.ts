#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { CreateRecurrenceRuleInput, CreateTaskInput, RecurrenceRuleDTO, TaskDTO } from "../shared/types";

interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

const usage = `
tiny-todo CLI

Commands:
  add <title> [--note <text>] [--due YYYY-MM-DD]
  list [--status open|done|all]
  done <task-id>
  recur <title-template> --cadence daily|weekly [--interval N] [--weekdays 1,3,5] [--note <text>] [--start YYYY-MM-DD] [--timezone Area/City] [--skip YYYY-MM-DD[,YYYY-MM-DD...]]
  sync-agent [--out agent/snapshot.md]
  token-hash <token>

Environment:
  TODO_API_URL    API base URL (default: http://127.0.0.1:8787)
  TODO_API_TOKEN  Bearer token used for API auth
`;

const parseArgs = (args: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { positionals, options };
};

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const apiBaseUrl = process.env.TODO_API_URL ?? "http://127.0.0.1:8787";
const apiToken = process.env.TODO_API_TOKEN;

const requireToken = (): string => {
  if (!apiToken) {
    throw new Error("TODO_API_TOKEN is required");
  }
  return apiToken;
};

const request = async <T>(pathName: string, init?: RequestInit): Promise<T> => {
  const url = `${apiBaseUrl}${pathName}`;
  const token = requireToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers
    }
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    const maybeError = body as { error?: unknown };
    const message =
      typeof body === "object" && body !== null && typeof maybeError.error === "string"
        ? maybeError.error
        : `request failed with ${response.status}`;
    throw new Error(message);
  }
  return body as T;
};

const printTasks = (tasks: TaskDTO[]): void => {
  if (tasks.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  for (const task of tasks) {
    const status = task.status === "done" ? "x" : " ";
    const due = task.dueDate ? ` due:${task.dueDate}` : "";
    const note = task.note ? ` | ${task.note}` : "";
    process.stdout.write(`[${status}] ${task.id} ${task.title}${due}${note}\n`);
  }
};

const formatRule = (rule: RecurrenceRuleDTO): string => {
  const cadence = `${rule.cadence}/${rule.interval}`;
  const weekdays = rule.weekdays?.length ? ` weekdays:${rule.weekdays.join(",")}` : "";
  const exceptionDates = rule.exceptionDates?.length ? ` skip:${rule.exceptionDates.join(",")}` : "";
  return `${rule.id} ${rule.titleTemplate} (${cadence}${weekdays}) tz:${rule.timezone} next:${rule.nextRunDate}${exceptionDates}`;
};

const deterministicTaskSort = (left: TaskDTO, right: TaskDTO): number => {
  const leftDue = left.dueDate ?? "9999-99-99";
  const rightDue = right.dueDate ?? "9999-99-99";
  if (left.status !== right.status) {
    return left.status.localeCompare(right.status);
  }
  if (leftDue !== rightDue) {
    return leftDue.localeCompare(rightDue);
  }
  return left.id.localeCompare(right.id);
};

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

const syncAgentSnapshot = async (outPathArg: string | undefined): Promise<void> => {
  const outPath = path.resolve(process.cwd(), outPathArg ?? "agent/snapshot.md");
  const [{ tasks }, { recurrenceRules }] = await Promise.all([
    request<{ tasks: TaskDTO[] }>("/tasks?status=all&limit=500"),
    request<{ recurrenceRules: RecurrenceRuleDTO[] }>("/recurrence-rules")
  ]);

  const sortedTasks = [...tasks].sort(deterministicTaskSort);
  const sortedRules = [...recurrenceRules].sort((a, b) => a.id.localeCompare(b.id));

  const lines: string[] = ["# Deterministic Todo Snapshot", ""];
  lines.push("## Open Tasks");
  const openTasks = sortedTasks.filter((task) => task.status === "open");
  if (openTasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of openTasks) {
      lines.push(`- ${task.id} | ${task.title} | due:${task.dueDate ?? "none"} | note:${task.note ?? ""}`);
    }
  }

  lines.push("", "## Done Tasks");
  const doneTasks = sortedTasks.filter((task) => task.status === "done");
  if (doneTasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of doneTasks) {
      lines.push(`- ${task.id} | ${task.title} | done:${task.completedAt ?? "unknown"}`);
    }
  }

  lines.push("", "## Recurrence Rules");
  if (sortedRules.length === 0) {
    lines.push("- none");
  } else {
    for (const rule of sortedRules) {
      const weekdays = rule.weekdays?.length ? rule.weekdays.join(",") : "none";
      lines.push(
        `- ${rule.id} | ${rule.titleTemplate} | cadence:${rule.cadence} | interval:${rule.interval} | weekdays:${weekdays} | timezone:${rule.timezone} | skip:${rule.exceptionDates?.join(",") ?? "none"} | next:${rule.nextRunDate}`
      );
    }
  }

  lines.push("");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${lines.join("\n")}`, "utf8");
  process.stdout.write(`Wrote deterministic snapshot to ${outPath}\n`);
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    process.stdout.write(usage);
    return;
  }

  if (command === "add") {
    const parsed = parseArgs(rest);
    const title = parsed.positionals.join(" ").trim();
    if (!title) {
      throw new Error("add requires a title");
    }

    const note = typeof parsed.options.note === "string" ? parsed.options.note : undefined;
    const due = typeof parsed.options.due === "string" ? parsed.options.due : undefined;
    if (due && !isIsoDate(due)) {
      throw new Error("--due must be YYYY-MM-DD");
    }

    const payload: CreateTaskInput = { title };
    if (note) {
      payload.note = note;
    }
    if (due) {
      payload.dueDate = due;
    }
    const { task } = await request<{ task: TaskDTO }>("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    process.stdout.write(`Created task ${task.id}\n`);
    return;
  }

  if (command === "list") {
    const parsed = parseArgs(rest);
    const status = typeof parsed.options.status === "string" ? parsed.options.status : "open";
    if (!["open", "done", "all"].includes(status)) {
      throw new Error("--status must be open, done, or all");
    }

    const { tasks } = await request<{ tasks: TaskDTO[] }>(`/tasks?status=${status}&limit=200`);
    printTasks(tasks);
    return;
  }

  if (command === "done") {
    const parsed = parseArgs(rest);
    const taskId = parsed.positionals[0];
    if (!taskId) {
      throw new Error("done requires a task id");
    }

    const { task } = await request<{ task: TaskDTO }>(`/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST"
    });
    process.stdout.write(`Completed task ${task.id}\n`);
    return;
  }

  if (command === "recur") {
    const parsed = parseArgs(rest);
    const titleTemplate = parsed.positionals.join(" ").trim();
    if (!titleTemplate) {
      throw new Error("recur requires a title-template");
    }

    const cadence = typeof parsed.options.cadence === "string" ? parsed.options.cadence : "daily";
    if (cadence !== "daily" && cadence !== "weekly") {
      throw new Error("--cadence must be daily or weekly");
    }

    const intervalRaw = typeof parsed.options.interval === "string" ? Number(parsed.options.interval) : 1;
    const interval = Number.isFinite(intervalRaw) ? Math.max(1, Math.floor(intervalRaw)) : 1;

    const noteTemplate = typeof parsed.options.note === "string" ? parsed.options.note : undefined;
    const anchorDate = typeof parsed.options.start === "string" ? parsed.options.start : undefined;
    const timezone = typeof parsed.options.timezone === "string" ? parsed.options.timezone.trim() : undefined;
    if (anchorDate && !isIsoDate(anchorDate)) {
      throw new Error("--start must be YYYY-MM-DD");
    }

    const exceptionDates =
      typeof parsed.options.skip === "string"
        ? parsed.options.skip
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : undefined;
    if (exceptionDates?.some((date) => !isIsoDate(date))) {
      throw new Error("--skip values must be YYYY-MM-DD");
    }

    const weekdayValues =
      typeof parsed.options.weekdays === "string"
        ? parsed.options.weekdays
            .split(",")
            .map((part) => Number(part.trim()))
            .filter((part) => Number.isInteger(part) && part >= 0 && part <= 6)
        : undefined;

    const payload: CreateRecurrenceRuleInput = {
      titleTemplate,
      cadence,
      interval
    };
    if (noteTemplate) {
      payload.noteTemplate = noteTemplate;
    }
    if (weekdayValues && weekdayValues.length > 0) {
      payload.weekdays = weekdayValues;
    }
    if (anchorDate) {
      payload.anchorDate = anchorDate;
    }
    if (timezone) {
      payload.timezone = timezone;
    }
    if (exceptionDates && exceptionDates.length > 0) {
      payload.exceptionDates = exceptionDates;
    }
    const { recurrenceRule } = await request<{ recurrenceRule: RecurrenceRuleDTO }>("/recurrence-rules", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    process.stdout.write(`Created recurrence rule ${formatRule(recurrenceRule)}\n`);
    return;
  }

  if (command === "sync-agent") {
    const parsed = parseArgs(rest);
    const outPath = typeof parsed.options.out === "string" ? parsed.options.out : undefined;
    await syncAgentSnapshot(outPath);
    return;
  }

  if (command === "token-hash") {
    const parsed = parseArgs(rest);
    const token = parsed.positionals[0]?.trim();
    if (!token) {
      throw new Error("token-hash requires a token argument");
    }
    process.stdout.write(`${tokenHash(token)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n\n${usage}`);
  process.exit(1);
});
