import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens, idempotencyRecords, recurrenceRules, tasks, users } from "../../drizzle/schema";
import type {
  CreateRecurrenceRuleInput,
  CreateTaskInput,
  RecurrenceRuleDTO,
  TaskDTO,
  TaskStatus,
  UpdateRecurrenceRuleInput,
  UpdateTaskInput
} from "../shared/types";

interface Env {
  DB: D1Database;
}

interface AuthContext {
  userId: string;
}

interface ApiError {
  error: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const error = (message: string, status = 400): Response => json({ error: message } satisfies ApiError, status);

const MAX_MATERIALIZATION_STEPS = 366;
const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_KEY_LENGTH = 200;

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const parseIsoDate = (value: string): { year: number; month: number; day: number } | null => {
  if (!isIsoDate(value)) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
};

const isValidIsoDate = (value: string): boolean => parseIsoDate(value) !== null;

const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const toDate = (value: string): Date => new Date(`${value}T00:00:00Z`);

const dateToIso = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (value: string, amount: number): string => {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateToIso(date);
};

const todayIsoInTimezone = (timeZone: string, now = new Date()): string => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return dateToIso(now);
  }

  return `${year}-${month}-${day}`;
};

const weeksBetween = (anchor: string, candidate: string): number => {
  const ms = toDate(candidate).getTime() - toDate(anchor).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24 * 7)));
};

const normalizeWeekdays = (weekdays: number[] | null | undefined): number[] | null => {
  if (!weekdays || weekdays.length === 0) {
    return null;
  }
  const deduped = [...new Set(weekdays)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return deduped.length > 0 ? deduped.sort((a, b) => a - b) : null;
};

const normalizeExceptionDates = (exceptionDates: string[] | null | undefined): string[] | null => {
  if (!exceptionDates || exceptionDates.length === 0) {
    return null;
  }

  const deduped = [...new Set(exceptionDates.map((value) => value.trim()))]
    .filter((value) => value.length > 0 && isValidIsoDate(value))
    .sort((left, right) => left.localeCompare(right));

  return deduped.length > 0 ? deduped : null;
};

const computeNextRunDate = (rule: typeof recurrenceRules.$inferSelect, fromDate: string): string => {
  if (rule.cadence === "daily") {
    return addDays(fromDate, rule.interval);
  }

  if (rule.cadence !== "weekly") {
    return addDays(fromDate, 1);
  }

  const weekdays = normalizeWeekdays(rule.weekdays);
  if (!weekdays) {
    return addDays(fromDate, 7 * rule.interval);
  }

  let cursor = addDays(fromDate, 1);
  for (let i = 0; i < 370; i += 1) {
    const dayOfWeek = toDate(cursor).getUTCDay();
    const validWeek = weeksBetween(rule.anchorDate, cursor) % rule.interval === 0;
    if (weekdays.includes(dayOfWeek) && validWeek) {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }

  return addDays(fromDate, 7 * rule.interval);
};

const mapTask = (row: typeof tasks.$inferSelect): TaskDTO => ({
  id: row.id,
  title: row.title,
  note: row.note,
  status: row.status as TaskStatus,
  dueDate: row.dueDate,
  recurrenceRuleId: row.recurrenceRuleId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt
});

const mapRule = (row: typeof recurrenceRules.$inferSelect): RecurrenceRuleDTO => ({
  id: row.id,
  titleTemplate: row.titleTemplate,
  noteTemplate: row.noteTemplate,
  cadence: row.cadence as "daily" | "weekly",
  interval: row.interval,
  weekdays: normalizeWeekdays(row.weekdays),
  timezone: row.timezone,
  anchorDate: row.anchorDate,
  nextRunDate: row.nextRunDate,
  exceptionDates: normalizeExceptionDates(row.exceptionDates),
  active: row.active,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const dbForEnv = (env: Env) => drizzle(env.DB, { schema: { users, apiTokens, tasks, recurrenceRules, idempotencyRecords } });

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
};

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const isUniqueConstraintError = (value: unknown): boolean => {
  if (!(value instanceof Error)) {
    return false;
  }
  return value.message.toLowerCase().includes("unique constraint failed");
};

const replayIdempotencyRecord = (record: typeof idempotencyRecords.$inferSelect): Response =>
  new Response(record.responseBody, {
    status: record.statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-replayed": "true"
    }
  });

const withIdempotency = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  action: () => Promise<Response>
): Promise<Response> => {
  const key = request.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    return action();
  }
  if (key.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
    return error(`Idempotency-Key must be <= ${IDEMPOTENCY_MAX_KEY_LENGTH} characters`, 422);
  }

  const db = dbForEnv(env);
  const path = new URL(request.url).pathname;
  const bodyText = await request.clone().text();
  const requestHash = await sha256Hex(bodyText);
  const nowIso = new Date().toISOString();

  const existingRows = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.idempotencyKey, key),
        eq(idempotencyRecords.userId, auth.userId),
        eq(idempotencyRecords.method, request.method),
        eq(idempotencyRecords.path, path)
      )
    );

  const existing = existingRows[0];
  if (existing) {
    if (existing.expiresAt <= nowIso) {
      await db
        .delete(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.idempotencyKey, key),
            eq(idempotencyRecords.userId, auth.userId),
            eq(idempotencyRecords.method, request.method),
            eq(idempotencyRecords.path, path)
          )
        );
    } else {
      if (existing.requestHash !== requestHash) {
        return error("idempotency key was already used with a different request body", 409);
      }
      return replayIdempotencyRecord(existing);
    }
  }

  const response = await action();
  if (response.status >= 500) {
    return response;
  }

  const responseBody = await response.clone().text();
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();

  try {
    await db.insert(idempotencyRecords).values({
      idempotencyKey: key,
      userId: auth.userId,
      method: request.method,
      path,
      requestHash,
      statusCode: response.status,
      responseBody,
      createdAt: nowIso,
      expiresAt
    });
  } catch (insertError) {
    if (!isUniqueConstraintError(insertError)) {
      throw insertError;
    }

    const conflictRows = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.idempotencyKey, key),
          eq(idempotencyRecords.userId, auth.userId),
          eq(idempotencyRecords.method, request.method),
          eq(idempotencyRecords.path, path)
        )
      );

    const conflict = conflictRows[0];
    if (conflict) {
      if (conflict.requestHash !== requestHash) {
        return error("idempotency key was already used with a different request body", 409);
      }
      return replayIdempotencyRecord(conflict);
    }
  }

  return response;
};

const requireBearerAuth = async (request: Request, env: Env): Promise<AuthContext | Response> => {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return error("missing bearer token", 401);
  }

  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return error("invalid bearer token", 401);
  }

  const tokenHash = await sha256Hex(token);
  const db = dbForEnv(env);

  const [tokenRow] = await db
    .select({ tokenId: apiTokens.id, userId: apiTokens.userId, userActive: users.active })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));

  if (!tokenRow || !tokenRow.userActive) {
    return error("invalid bearer token", 401);
  }

  await db.update(apiTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiTokens.id, tokenRow.tokenId));

  return {
    userId: tokenRow.userId
  };
};

const createTask = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const payload = await parseJsonBody<CreateTaskInput>(request);
  if (!payload?.title?.trim()) {
    return error("title is required", 422);
  }
  if (payload.dueDate && !isValidIsoDate(payload.dueDate)) {
    return error("dueDate must be YYYY-MM-DD", 422);
  }

  const db = dbForEnv(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(tasks).values({
    id,
    userId: auth.userId,
    title: payload.title.trim(),
    note: payload.note?.trim() || null,
    status: "open",
    dueDate: payload.dueDate ?? null,
    recurrenceRuleId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  });

  const created = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, auth.userId)));
  if (!created[0]) {
    return error("failed to create task", 500);
  }
  return json({ task: mapTask(created[0]) }, 201);
};

const listTasks = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "open").toLowerCase();
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

  const rows =
    status === "all"
      ? await db
          .select()
          .from(tasks)
          .where(eq(tasks.userId, auth.userId))
          .orderBy(asc(tasks.status), asc(tasks.dueDate), asc(tasks.createdAt), asc(tasks.id))
          .limit(safeLimit)
          .offset(safeOffset)
      : await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.userId, auth.userId), eq(tasks.status, status === "done" ? "done" : "open")))
          .orderBy(asc(tasks.dueDate), asc(tasks.createdAt), asc(tasks.id))
          .limit(safeLimit)
          .offset(safeOffset);

  return json({ tasks: rows.map(mapTask) });
};

const updateTask = async (request: Request, env: Env, auth: AuthContext, taskId: string): Promise<Response> => {
  const payload = await parseJsonBody<UpdateTaskInput>(request);
  if (!payload) {
    return error("invalid JSON body", 422);
  }

  const updates: Partial<typeof tasks.$inferInsert> = {
    updatedAt: new Date().toISOString()
  };
  if (payload.title !== undefined) {
    const title = payload.title.trim();
    if (!title) {
      return error("title cannot be empty", 422);
    }
    updates.title = title;
  }
  if (payload.note !== undefined) {
    updates.note = payload.note?.trim() || null;
  }
  if (payload.dueDate !== undefined) {
    if (payload.dueDate !== null && !isValidIsoDate(payload.dueDate)) {
      return error("dueDate must be YYYY-MM-DD or null", 422);
    }
    updates.dueDate = payload.dueDate;
  }
  if (Object.keys(updates).length === 1) {
    return error("no updates provided", 422);
  }

  const db = dbForEnv(env);
  await db.update(tasks).set(updates).where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.userId)));
  const updated = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.userId)));
  if (!updated[0]) {
    return error("task not found", 404);
  }
  return json({ task: mapTask(updated[0]) });
};

const completeTask = async (env: Env, auth: AuthContext, taskId: string): Promise<Response> => {
  const db = dbForEnv(env);
  const now = new Date().toISOString();

  await db
    .update(tasks)
    .set({ status: "done", completedAt: now, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.userId)));

  const updated = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.userId)));
  if (!updated[0]) {
    return error("task not found", 404);
  }
  return json({ task: mapTask(updated[0]) });
};

const createRecurrenceRule = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const payload = await parseJsonBody<CreateRecurrenceRuleInput>(request);
  if (!payload?.titleTemplate?.trim()) {
    return error("titleTemplate is required", 422);
  }
  if (payload.cadence !== "daily" && payload.cadence !== "weekly") {
    return error("cadence must be daily or weekly", 422);
  }

  const interval = Math.max(1, Math.floor(payload.interval ?? 1));
  const weekdays = normalizeWeekdays(payload.weekdays);
  if (payload.cadence === "weekly" && payload.weekdays && !weekdays) {
    return error("weekdays must contain values between 0 and 6", 422);
  }

  const timezone = payload.timezone?.trim() || "UTC";
  if (!isValidTimeZone(timezone)) {
    return error("timezone must be a valid IANA timezone", 422);
  }

  const anchorDate = payload.anchorDate ?? todayIsoInTimezone(timezone);
  if (!isValidIsoDate(anchorDate)) {
    return error("anchorDate must be YYYY-MM-DD", 422);
  }

  const exceptionDates = normalizeExceptionDates(payload.exceptionDates);
  if (payload.exceptionDates && payload.exceptionDates.length > 0 && !exceptionDates) {
    return error("exceptionDates must contain YYYY-MM-DD values", 422);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const db = dbForEnv(env);

  await db.insert(recurrenceRules).values({
    id,
    userId: auth.userId,
    titleTemplate: payload.titleTemplate.trim(),
    noteTemplate: payload.noteTemplate?.trim() || null,
    cadence: payload.cadence,
    interval,
    weekdays,
    timezone,
    anchorDate,
    nextRunDate: anchorDate,
    exceptionDates,
    active: true,
    createdAt: now,
    updatedAt: now
  });

  const created = await db
    .select()
    .from(recurrenceRules)
    .where(and(eq(recurrenceRules.id, id), eq(recurrenceRules.userId, auth.userId)));
  if (!created[0]) {
    return error("failed to create recurrence rule", 500);
  }
  return json({ recurrenceRule: mapRule(created[0]) }, 201);
};

const listRecurrenceRules = async (env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const rows = await db
    .select()
    .from(recurrenceRules)
    .where(and(eq(recurrenceRules.userId, auth.userId), eq(recurrenceRules.active, true)))
    .orderBy(asc(recurrenceRules.nextRunDate), asc(recurrenceRules.id));

  return json({ recurrenceRules: rows.map(mapRule) });
};

const updateRecurrenceRule = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  ruleId: string
): Promise<Response> => {
  const payload = await parseJsonBody<UpdateRecurrenceRuleInput>(request);
  if (!payload) {
    return error("invalid JSON body", 422);
  }

  const updates: Partial<typeof recurrenceRules.$inferInsert> = {
    updatedAt: new Date().toISOString()
  };

  if (payload.timezone !== undefined) {
    const timezone = payload.timezone.trim();
    if (!timezone || !isValidTimeZone(timezone)) {
      return error("timezone must be a valid IANA timezone", 422);
    }
    updates.timezone = timezone;
  }

  if (payload.exceptionDates !== undefined) {
    const exceptionDates = normalizeExceptionDates(payload.exceptionDates);
    if (payload.exceptionDates.length > 0 && !exceptionDates) {
      return error("exceptionDates must contain YYYY-MM-DD values", 422);
    }
    updates.exceptionDates = exceptionDates;
  }

  if (payload.active !== undefined) {
    updates.active = payload.active;
  }

  if (payload.nextRunDate !== undefined) {
    if (!isValidIsoDate(payload.nextRunDate)) {
      return error("nextRunDate must be YYYY-MM-DD", 422);
    }
    updates.nextRunDate = payload.nextRunDate;
  }

  if (Object.keys(updates).length === 1) {
    return error("no updates provided", 422);
  }

  const db = dbForEnv(env);
  await db
    .update(recurrenceRules)
    .set(updates)
    .where(and(eq(recurrenceRules.id, ruleId), eq(recurrenceRules.userId, auth.userId)));

  const updated = await db
    .select()
    .from(recurrenceRules)
    .where(and(eq(recurrenceRules.id, ruleId), eq(recurrenceRules.userId, auth.userId)));
  if (!updated[0]) {
    return error("recurrence rule not found", 404);
  }

  return json({ recurrenceRule: mapRule(updated[0]) });
};

const materializeRecurrences = async (
  env: Env,
  onDate?: string,
  userId?: string
): Promise<{ created: number; rulesProcessed: number }> => {
  const db = dbForEnv(env);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const materializationFilter = userId
    ? and(eq(recurrenceRules.userId, userId), eq(recurrenceRules.active, true))
    : eq(recurrenceRules.active, true);

  const activeRules = await db
    .select()
    .from(recurrenceRules)
    .where(materializationFilter)
    .orderBy(asc(recurrenceRules.nextRunDate), asc(recurrenceRules.id));

  let created = 0;
  let rulesProcessed = 0;
  for (const rule of activeRules) {
    const targetDate = onDate ?? todayIsoInTimezone(rule.timezone, nowDate);
    if (rule.nextRunDate > targetDate) {
      continue;
    }

    rulesProcessed += 1;
    const exceptionDateSet = new Set(normalizeExceptionDates(rule.exceptionDates) ?? []);
    let cursor = rule.nextRunDate;
    let safetyCounter = 0;
    while (cursor <= targetDate && safetyCounter < MAX_MATERIALIZATION_STEPS) {
      if (!exceptionDateSet.has(cursor)) {
        try {
          await db.insert(tasks).values({
            id: crypto.randomUUID(),
            userId: rule.userId,
            title: rule.titleTemplate,
            note: rule.noteTemplate,
            status: "open",
            dueDate: cursor,
            recurrenceRuleId: rule.id,
            createdAt: now,
            updatedAt: now,
            completedAt: null
          });
          created += 1;
        } catch (insertError) {
          if (!isUniqueConstraintError(insertError)) {
            throw insertError;
          }
        }
      }

      cursor = computeNextRunDate(rule, cursor);
      safetyCounter += 1;
    }

    await db
      .update(recurrenceRules)
      .set({
        nextRunDate: cursor,
        updatedAt: now
      })
      .where(and(eq(recurrenceRules.id, rule.id), eq(recurrenceRules.userId, rule.userId)));
  }

  return { created, rulesProcessed };
};

const runMaterialization = async (request: Request, env: Env, auth: AuthContext): Promise<Response> =>
  withIdempotency(request, env, auth, async () => {
    const body = await parseJsonBody<{ date?: string }>(request);
    if (body?.date && !isValidIsoDate(body.date)) {
      return error("date must be YYYY-MM-DD", 422);
    }
    const result = await materializeRecurrences(env, body?.date, auth.userId);
    return json({ ok: true, ...result });
  });

const routeTaskId = (pathname: string): { taskId: string; complete: boolean } | null => {
  const completeMatch = pathname.match(/^\/tasks\/([^/]+)\/complete$/);
  if (completeMatch) {
    const rawTaskId = completeMatch[1];
    if (!rawTaskId) {
      return null;
    }
    return { taskId: decodeURIComponent(rawTaskId), complete: true };
  }

  const updateMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (updateMatch) {
    const rawTaskId = updateMatch[1];
    if (!rawTaskId) {
      return null;
    }
    return { taskId: decodeURIComponent(rawTaskId), complete: false };
  }
  return null;
};

const routeRecurrenceRuleId = (pathname: string): string | null => {
  const match = pathname.match(/^\/recurrence-rules\/([^/]+)$/);
  if (!match || !match[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
};

const handleFetch = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === "/health" && request.method === "GET") {
    return json({ ok: true });
  }

  const authResult = await requireBearerAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }
  const auth = authResult;

  if (pathname === "/tasks" && request.method === "POST") {
    return withIdempotency(request, env, auth, () => createTask(request, env, auth));
  }
  if (pathname === "/tasks" && request.method === "GET") {
    return listTasks(request, env, auth);
  }

  const taskRoute = routeTaskId(pathname);
  if (taskRoute && request.method === "PATCH" && !taskRoute.complete) {
    return updateTask(request, env, auth, taskRoute.taskId);
  }
  if (taskRoute && request.method === "POST" && taskRoute.complete) {
    return completeTask(env, auth, taskRoute.taskId);
  }

  if (pathname === "/recurrence-rules" && request.method === "POST") {
    return createRecurrenceRule(request, env, auth);
  }
  if (pathname === "/recurrence-rules" && request.method === "GET") {
    return listRecurrenceRules(env, auth);
  }

  const recurrenceRuleId = routeRecurrenceRuleId(pathname);
  if (recurrenceRuleId && request.method === "PATCH") {
    return updateRecurrenceRule(request, env, auth, recurrenceRuleId);
  }

  if (pathname === "/jobs/materialize-recurrence" && request.method === "POST") {
    return runMaterialization(request, env, auth);
  }

  return error("not found", 404);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(materializeRecurrences(env));
  }
};
