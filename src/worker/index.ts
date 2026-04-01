import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  apiTokens,
  auditEvents,
  idempotencyRecords,
  listMemberships,
  lists,
  recurrenceRules,
  taskTags,
  tasks,
  users
} from "../../drizzle/schema";
import { logError, logInfo, logWarn } from "./observability";
import type {
  CreateListInput,
  CreateRecurrenceRuleInput,
  CreateTaskInput,
  ListDTO,
  ListMembershipDTO,
  ListRole,
  ListTasksResponse,
  RecurrenceRuleDTO,
  TaskSort,
  TaskDTO,
  TaskStatus,
  UpsertListMembershipInput,
  UpdateRecurrenceRuleInput,
  UpdateTaskInput
} from "../shared/types";

interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  WEB_UI_PASSWORD_HASH?: string;
  WEB_UI_SESSION_SECRET?: string;
  WEB_UI_BEARER_TOKEN?: string;
}

interface AuthContext {
  userId: string;
}

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
}

interface ApiError {
  error: string;
}

const REQUIRED_OWNER_TAGS = new Set(["owner:user", "owner:agent"]);

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const error = (message: string, status = 400): Response => json({ error: message } satisfies ApiError, status);

const MAX_MATERIALIZATION_STEPS = 366;
const IDEMPOTENCY_HEADER = "idempotency-key";
const REQUEST_ID_HEADER = "x-request-id";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_KEY_LENGTH = 200;
const DEFAULT_LIST_NAME = "Default";
const LIST_ROLES: readonly ListRole[] = ["owner", "editor", "viewer"];
const LIST_ROLE_RANK: Record<ListRole, number> = {
  owner: 3,
  editor: 2,
  viewer: 1
};
const TASK_SORTS: readonly TaskSort[] = ["default", "due_date_asc", "due_date_desc", "created_at_asc", "created_at_desc"];
const UI_SESSION_COOKIE = "tiny_todo_ui_session";
const UI_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const ANALYTICS_THROUGHPUT_START_DATE = "2026-03-24";

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

const isTaskSort = (value: string): value is TaskSort => TASK_SORTS.includes(value as TaskSort);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

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

const timestampToIsoDate = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const quickMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (quickMatch) {
    return quickMatch[1] ?? null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
};

const toIsoDateInTimezone = (date: Date, timeZone: string): string => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return dateToIso(date);
  }
  return `${year}-${month}-${day}`;
};

const timestampToIsoDateInTimezone = (value: string | null | undefined, timeZone: string): string | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return timestampToIsoDate(value);
  }
  return toIsoDateInTimezone(parsed, timeZone);
};

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

const normalizeTaskTags = (tags: string[] | null | undefined): string[] | null => {
  if (!tags || tags.length === 0) {
    return null;
  }

  const normalized = [...new Set(tags.map((value) => value.trim().toLowerCase()))]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : null;
};

const validateRequiredCreateTaskTags = (tags: string[] | null): string | null => {
  if (!tags || tags.length === 0) {
    return "tags must include exactly one owner tag (owner:user or owner:agent) and one project:<slug> tag";
  }

  const ownerTags = tags.filter((tag) => REQUIRED_OWNER_TAGS.has(tag));
  const projectTags = tags.filter((tag) => /^project:[a-z0-9][a-z0-9-]*$/.test(tag));

  if (ownerTags.length !== 1 || projectTags.length !== 1) {
    return "tags must include exactly one owner tag (owner:user or owner:agent) and one project:<slug> tag";
  }

  return null;
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

const mapTask = (row: typeof tasks.$inferSelect, tags: string[] = []): TaskDTO => ({
  id: row.id,
  listId: row.listId,
  title: row.title,
  note: row.note,
  tags,
  status: row.status as TaskStatus,
  dueDate: row.dueDate,
  recurrenceRuleId: row.recurrenceRuleId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt
});

const mapRule = (row: typeof recurrenceRules.$inferSelect): RecurrenceRuleDTO => ({
  id: row.id,
  listId: row.listId,
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

const mapList = (
  listRow: typeof lists.$inferSelect,
  membershipRow: typeof listMemberships.$inferSelect
): ListDTO => ({
  id: listRow.id,
  name: listRow.name,
  createdByUserId: listRow.createdByUserId,
  createdAt: listRow.createdAt,
  updatedAt: listRow.updatedAt,
  myRole: membershipRow.role
});

const mapMembership = (row: typeof listMemberships.$inferSelect): ListMembershipDTO => ({
  listId: row.listId,
  userId: row.userId,
  role: row.role,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const dbForEnv = (env: Env) =>
  drizzle(env.DB, {
    schema: { users, apiTokens, lists, listMemberships, tasks, taskTags, recurrenceRules, idempotencyRecords, auditEvents }
  });

const isSafeRequestId = (value: string): boolean => /^[a-zA-Z0-9._:-]{8,128}$/.test(value);

const resolveRequestId = (request: Request): string => {
  const candidate = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (candidate && isSafeRequestId(candidate)) {
    return candidate;
  }
  return crypto.randomUUID();
};

const withRequestIdHeader = (response: Response, requestId: string): Response => {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const toRequestContext = (request: Request): RequestContext => {
  const url = new URL(request.url);
  return {
    requestId: resolveRequestId(request),
    method: request.method,
    path: url.pathname
  };
};

type AuditEventType =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "recurrence_rule.created"
  | "recurrence_rule.updated";

const writeAuditEvent = async (
  env: Env,
  requestContext: RequestContext,
  eventType: AuditEventType,
  actorUserId: string,
  resourceType: "task" | "recurrence_rule",
  resourceId: string,
  metadata: Record<string, unknown> | null = null
): Promise<void> => {
  const db = dbForEnv(env);
  await db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    eventType,
    actorUserId,
    resourceType,
    resourceId,
    requestId: requestContext.requestId,
    metadata,
    createdAt: new Date().toISOString()
  });
};

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
};

const parseCookies = (cookieHeader: string | null): Map<string, string> => {
  const parsed = new Map<string, string>();
  if (!cookieHeader) {
    return parsed;
  }

  for (const entry of cookieHeader.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      parsed.set(key, value);
    }
  }

  return parsed;
};

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

const hmacSha256Hex = async (secret: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(signature);
};

const issueUiSessionCookie = async (env: Env): Promise<string | null> => {
  const secret = env.WEB_UI_SESSION_SECRET;
  if (!secret) {
    return null;
  }
  const expiresAt = Date.now() + UI_SESSION_MAX_AGE_SECONDS * 1000;
  const payload = String(expiresAt);
  const signature = await hmacSha256Hex(secret, payload);
  const value = `${payload}.${signature}`;
  return `${UI_SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${UI_SESSION_MAX_AGE_SECONDS}`;
};

const clearUiSessionCookie = (): string =>
  `${UI_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

const hasValidUiSession = async (request: Request, env: Env): Promise<boolean> => {
  const secret = env.WEB_UI_SESSION_SECRET;
  if (!secret) {
    return false;
  }

  const sessionValue = parseCookies(request.headers.get("cookie")).get(UI_SESSION_COOKIE);
  if (!sessionValue) {
    return false;
  }

  const [expiresAtRaw, signature] = sessionValue.split(".");
  if (!expiresAtRaw || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return false;
  }

  const expectedSignature = await hmacSha256Hex(secret, expiresAtRaw);
  return timingSafeEqual(signature, expectedSignature);
};

const mapAppPathToAssetPath = (pathname: string): string => {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (pathname === "/" || pathname === "/index.html") {
    return "/index.html";
  }
  if (normalizedPath === "/analytics" || normalizedPath === "/settings" || normalizedPath === "/user") {
    return "/index.html";
  }
  if (pathname.startsWith("/assets/")) {
    return pathname;
  }
  if (pathname === "/favicon.ico") {
    return "/favicon.ico";
  }
  if (pathname === "/app" || pathname === "/app/") {
    return "/index.html";
  }
  if (pathname.startsWith("/app/")) {
    return pathname.slice("/app".length) || "/index.html";
  }
  return pathname;
};

const serveUiAsset = async (request: Request, env: Env): Promise<Response> => {
  if (!env.ASSETS) {
    return error("ASSETS binding is not configured", 500);
  }
  const assetPath = mapAppPathToAssetPath(new URL(request.url).pathname);
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;

  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const fallbackUrl = new URL(request.url);
  fallbackUrl.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));
};

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const isListRole = (value: unknown): value is ListRole =>
  typeof value === "string" && LIST_ROLES.includes(value as ListRole);

const hasMinimumRole = (value: ListRole, minimum: ListRole): boolean => LIST_ROLE_RANK[value] >= LIST_ROLE_RANK[minimum];

const loadMembership = async (
  env: Env,
  userId: string,
  listId: string
): Promise<typeof listMemberships.$inferSelect | null> => {
  const db = dbForEnv(env);
  const rows = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, userId)));
  return rows[0] ?? null;
};

const requireListRole = async (
  env: Env,
  auth: AuthContext,
  listId: string,
  minimumRole: ListRole
): Promise<typeof listMemberships.$inferSelect | Response> => {
  const membership = await loadMembership(env, auth.userId, listId);
  if (!membership) {
    return error("list not found", 404);
  }
  if (!hasMinimumRole(membership.role, minimumRole)) {
    return error("insufficient list role", 403);
  }
  return membership;
};

const ensureDefaultListForUser = async (env: Env, userId: string): Promise<string> => {
  const db = dbForEnv(env);
  const existing = await db
    .select({ listId: listMemberships.listId })
    .from(listMemberships)
    .where(and(eq(listMemberships.userId, userId), eq(listMemberships.role, "owner")))
    .orderBy(asc(listMemberships.createdAt), asc(listMemberships.listId))
    .limit(1);
  if (existing[0]?.listId) {
    return existing[0].listId;
  }

  const now = new Date().toISOString();
  const listId = `default:${userId}`;
  await db.insert(lists).values({
    id: listId,
    name: DEFAULT_LIST_NAME,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(listMemberships).values({
    listId,
    userId,
    role: "owner",
    createdAt: now,
    updatedAt: now
  });
  return listId;
};

const resolveWritableListId = async (
  env: Env,
  auth: AuthContext,
  requestedListId?: string
): Promise<string | Response> => {
  if (!requestedListId) {
    return ensureDefaultListForUser(env, auth.userId);
  }

  const roleResult = await requireListRole(env, auth, requestedListId, "editor");
  if (roleResult instanceof Response) {
    return roleResult;
  }
  return requestedListId;
};

const listIdsForMember = async (env: Env, userId: string, minimumRole: ListRole): Promise<string[]> => {
  const db = dbForEnv(env);
  const rows = await db
    .select({ listId: listMemberships.listId, role: listMemberships.role })
    .from(listMemberships)
    .where(eq(listMemberships.userId, userId));
  return rows.filter((row) => hasMinimumRole(row.role, minimumRole)).map((row) => row.listId);
};

const loadTaskTagsByTaskId = async (
  env: Env,
  taskIds: string[]
): Promise<Map<string, string[]>> => {
  const tagsByTaskId = new Map<string, string[]>();
  if (taskIds.length === 0) {
    return tagsByTaskId;
  }

  const db = dbForEnv(env);
  const TASK_ID_CHUNK_SIZE = 100;
  for (let index = 0; index < taskIds.length; index += TASK_ID_CHUNK_SIZE) {
    const chunk = taskIds.slice(index, index + TASK_ID_CHUNK_SIZE);
    const rows = await db
      .select({ taskId: taskTags.taskId, tag: taskTags.tag })
      .from(taskTags)
      .where(inArray(taskTags.taskId, chunk))
      .orderBy(asc(taskTags.taskId), asc(taskTags.tag));

    for (const row of rows) {
      const existing = tagsByTaskId.get(row.taskId);
      if (existing) {
        existing.push(row.tag);
        continue;
      }
      tagsByTaskId.set(row.taskId, [row.tag]);
    }
  }

  return tagsByTaskId;
};

const syncTaskTags = async (env: Env, taskId: string, userId: string, tags: string[] | null): Promise<void> => {
  const db = dbForEnv(env);
  await db.delete(taskTags).where(eq(taskTags.taskId, taskId));

  if (!tags || tags.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  await db.insert(taskTags).values(
    tags.map((tag) => ({
      taskId,
      userId,
      tag,
      createdAt: now
    }))
  );
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

const requireBearerAuth = async (request: Request, env: Env, requestContext: RequestContext): Promise<AuthContext | Response> => {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    logWarn({
      event: "auth.failure",
      requestId: requestContext.requestId,
      method: requestContext.method,
      path: requestContext.path,
      status: 401,
      details: { reason: "missing_bearer_token" }
    });
    return error("missing bearer token", 401);
  }

  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    logWarn({
      event: "auth.failure",
      requestId: requestContext.requestId,
      method: requestContext.method,
      path: requestContext.path,
      status: 401,
      details: { reason: "empty_bearer_token" }
    });
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
    logWarn({
      event: "auth.failure",
      requestId: requestContext.requestId,
      method: requestContext.method,
      path: requestContext.path,
      status: 401,
      details: { reason: "token_not_found_or_inactive_user" }
    });
    return error("invalid bearer token", 401);
  }

  await db.update(apiTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiTokens.id, tokenRow.tokenId));

  return {
    userId: tokenRow.userId
  };
};

const createTask = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  requestContext: RequestContext
): Promise<Response> => {
  const payload = await parseJsonBody<CreateTaskInput>(request);
  if (!payload) {
    return error("invalid JSON body", 422);
  }
  if (!payload?.title?.trim()) {
    return error("title is required", 422);
  }
  if (payload.dueDate && !isValidIsoDate(payload.dueDate)) {
    return error("dueDate must be YYYY-MM-DD", 422);
  }

  if (payload.listId !== undefined && !payload.listId.trim()) {
    return error("listId cannot be empty", 422);
  }

  const normalizedTags = normalizeTaskTags(payload.tags);
  if (payload.tags !== undefined && payload.tags.length > 0 && !normalizedTags) {
    return error("tags must contain at least one non-empty value", 422);
  }
  const tagValidationError = validateRequiredCreateTaskTags(normalizedTags);
  if (tagValidationError) {
    return error(tagValidationError, 422);
  }

  const db = dbForEnv(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const listIdResult = await resolveWritableListId(env, auth, payload.listId);
  if (listIdResult instanceof Response) {
    return listIdResult;
  }

  await db.insert(tasks).values({
    id,
    userId: auth.userId,
    listId: listIdResult,
    title: payload.title.trim(),
    note: payload.note?.trim() || null,
    status: "open",
    dueDate: payload.dueDate ?? null,
    recurrenceRuleId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  });

  await syncTaskTags(env, id, auth.userId, normalizedTags);

  const created = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!created[0]) {
    return error("failed to create task", 500);
  }

  await writeAuditEvent(env, requestContext, "task.created", auth.userId, "task", id, {
    status: "open",
    dueDate: payload.dueDate ?? null,
    recurrenceRuleId: null
  });
  logInfo({
    event: "task.mutated",
    requestId: requestContext.requestId,
    method: requestContext.method,
    path: requestContext.path,
    userId: auth.userId,
    resourceType: "task",
    resourceId: id,
    status: 201,
    details: { action: "create" }
  });
  return json({ task: mapTask(created[0], normalizedTags ?? []) }, 201);
};

const listTasks = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const url = new URL(request.url);
  const statusQuery = (url.searchParams.get("status") ?? "open").toLowerCase();
  const status: TaskStatus | "all" = statusQuery === "all" ? "all" : statusQuery === "done" ? "done" : "open";
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const listIdParam = url.searchParams.get("listId") ?? url.searchParams.get("list_id");
  const search = url.searchParams.get("search")?.trim() ?? "";
  const dueBefore = url.searchParams.get("due-before")?.trim() ?? null;
  const dueAfter = url.searchParams.get("due-after")?.trim() ?? null;
  const listId = listIdParam?.trim() ?? null;
  const sortQuery = (url.searchParams.get("sort") ?? "default").trim().toLowerCase();
  const tagFilter = url.searchParams
    .getAll("tag")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (dueBefore && !isValidIsoDate(dueBefore)) {
    return error("due-before must be YYYY-MM-DD", 422);
  }
  if (dueAfter && !isValidIsoDate(dueAfter)) {
    return error("due-after must be YYYY-MM-DD", 422);
  }
  if (listId !== null && !listId) {
    return error("list_id cannot be empty", 422);
  }
  if (!isTaskSort(sortQuery)) {
    return error(`sort must be one of: ${TASK_SORTS.join(", ")}`, 422);
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const sort = sortQuery;

  let allowedListIds: string[];
  if (listId) {
    const roleResult = await requireListRole(env, auth, listId, "viewer");
    if (roleResult instanceof Response) {
      return roleResult;
    }
    allowedListIds = [listId];
  } else {
    allowedListIds = await listIdsForMember(env, auth.userId, "viewer");
  }

  if (allowedListIds.length === 0) {
    return json({ tasks: [] });
  }

  const filters: SQL[] = [inArray(tasks.listId, allowedListIds)];
  if (status !== "all") {
    filters.push(eq(tasks.status, status));
  }
  if (dueBefore) {
    filters.push(lte(tasks.dueDate, dueBefore));
  }
  if (dueAfter) {
    filters.push(gte(tasks.dueDate, dueAfter));
  }
  if (listId) {
    filters.push(eq(tasks.listId, listId));
  }
  if (search) {
    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    filters.push(
      sql`(lower(${tasks.title}) LIKE ${pattern} ESCAPE '\\' OR lower(coalesce(${tasks.note}, '')) LIKE ${pattern} ESCAPE '\\')`
    );
  }
  if (tagFilter.length > 0) {
    filters.push(
      sql`EXISTS (
        SELECT 1
        FROM ${taskTags}
        WHERE ${taskTags.taskId} = ${tasks.id}
          AND lower(${taskTags.tag}) IN (${sql.join(
          tagFilter.map((tag) => sql`${tag}`),
          sql`, `
        )})
      )`
    );
  }

  const orderBy =
    sort === "default"
      ? status === "all"
        ? [asc(tasks.status), asc(tasks.dueDate), asc(tasks.createdAt), asc(tasks.id)]
        : [asc(tasks.dueDate), asc(tasks.createdAt), asc(tasks.id)]
      : sort === "due_date_asc"
        ? [asc(tasks.dueDate), asc(tasks.createdAt), asc(tasks.id)]
        : sort === "due_date_desc"
          ? [desc(tasks.dueDate), desc(tasks.createdAt), desc(tasks.id)]
          : sort === "created_at_asc"
            ? [asc(tasks.createdAt), asc(tasks.id)]
            : [desc(tasks.createdAt), desc(tasks.id)];

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(safeLimit)
    .offset(safeOffset);

  const tagsByTaskId = await loadTaskTagsByTaskId(
    env,
    rows.map((row) => row.id)
  );

  return json({ tasks: rows.map((row) => mapTask(row, tagsByTaskId.get(row.id) ?? [])) } satisfies ListTasksResponse);
};

const analyticsOverview = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const url = new URL(request.url);
  const daysRaw = Number(url.searchParams.get("days") ?? "30");
  const timeZone = (url.searchParams.get("timeZone") ?? "UTC").trim() || "UTC";
  const listIdParam = url.searchParams.get("listId") ?? url.searchParams.get("list_id");
  const listId = listIdParam?.trim() ?? null;

  if (listId !== null && !listId) {
    return error("list_id cannot be empty", 422);
  }
  if (!isValidTimeZone(timeZone)) {
    return error("timeZone must be a valid IANA timezone", 422);
  }

  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 30;
  const endDate = todayIsoInTimezone(timeZone);
  const requestedStartDate = addDays(endDate, -(days - 1));
  const startDate = requestedStartDate < ANALYTICS_THROUGHPUT_START_DATE ? ANALYTICS_THROUGHPUT_START_DATE : requestedStartDate;

  let allowedListIds: string[];
  if (listId) {
    const roleResult = await requireListRole(env, auth, listId, "viewer");
    if (roleResult instanceof Response) {
      return roleResult;
    }
    allowedListIds = [listId];
  } else {
    allowedListIds = await listIdsForMember(env, auth.userId, "viewer");
  }

  if (allowedListIds.length === 0) {
    return json({
      analytics: {
        schemaVersion: "2026-03-27",
        generatedAt: new Date().toISOString(),
        window: { days, startDate, endDate, timeZone },
        totals: {
          tasksVisible: 0,
          openNow: 0,
          doneNow: 0,
          overdueOpen: 0,
          createdInWindow: 0,
          completedInWindow: 0,
          completionRateInWindow: 0
        },
        daily: [],
        breakdowns: {
          owner: [],
          project: []
        },
        guidance: {
          definitions: {
            createdInWindow: `Tasks with createdAt between ${startDate} and ${endDate}, inclusive.`,
            completedInWindow: `Tasks with completedAt between ${startDate} and ${endDate}, inclusive.`,
            completionRateInWindow: "completedInWindow / createdInWindow; returns 0 when createdInWindow is 0.",
            overdueOpen: "Open tasks where dueDate is before today (UTC).",
            timeZone: `Window boundaries and daily aggregation use ${timeZone}.`,
            throughputStartAnchor: `Throughput analytics do not include days before ${ANALYTICS_THROUGHPUT_START_DATE}.`,
            tasksVisible: "All tasks the caller can read after list membership filtering."
          },
          interpretationHints: [
            "If createdInWindow consistently exceeds completedInWindow, backlog likely grows.",
            "If overdueOpen rises, prioritize aging and due-date hygiene.",
            "Owner and project breakdowns help route work and rebalance throughput."
          ]
        }
      }
    });
  }

  const LIST_ID_CHUNK_SIZE = 200;
  const listIdChunks: string[][] = [];
  for (let index = 0; index < allowedListIds.length; index += LIST_ID_CHUNK_SIZE) {
    listIdChunks.push(allowedListIds.slice(index, index + LIST_ID_CHUNK_SIZE));
  }

  const rows: Array<typeof tasks.$inferSelect> = [];
  for (const chunk of listIdChunks) {
    const chunkRows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.listId, chunk));
    rows.push(...chunkRows);
  }
  rows.sort((left, right) => {
    const createdAtDiff = left.createdAt.localeCompare(right.createdAt);
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }
    return left.id.localeCompare(right.id);
  });

  const tagsByTaskId = new Map<string, string[]>();
  for (const chunk of listIdChunks) {
    const tagRows = await db
      .select({ taskId: taskTags.taskId, tag: taskTags.tag })
      .from(taskTags)
      .innerJoin(tasks, eq(tasks.id, taskTags.taskId))
      .where(inArray(tasks.listId, chunk))
      .orderBy(asc(taskTags.taskId), asc(taskTags.tag));

    for (const row of tagRows) {
      const existing = tagsByTaskId.get(row.taskId);
      if (existing) {
        existing.push(row.tag);
        continue;
      }
      tagsByTaskId.set(row.taskId, [row.tag]);
    }
  }

  const daily = new Map<string, { date: string; created: number; completed: number }>();
  let cursor = startDate;
  while (cursor <= endDate) {
    daily.set(cursor, { date: cursor, created: 0, completed: 0 });
    cursor = addDays(cursor, 1);
  }

  const ownerBreakdown = new Map<string, { owner: string; openNow: number; createdInWindow: number; completedInWindow: number }>();
  const projectBreakdown = new Map<
    string,
    { projectTag: string; openNow: number; createdInWindow: number; completedInWindow: number }
  >();

  let openNow = 0;
  let doneNow = 0;
  let overdueOpen = 0;
  let createdInWindow = 0;
  let completedInWindow = 0;

  for (const row of rows) {
    const createdDay = timestampToIsoDateInTimezone(row.createdAt, timeZone);
    const completedDay = timestampToIsoDateInTimezone(row.completedAt, timeZone);
    const tags = tagsByTaskId.get(row.id) ?? [];

    const ownerTag = tags.find((tag) => tag === "owner:user" || tag === "owner:agent") ?? "owner:unknown";
    const ownerEntry = ownerBreakdown.get(ownerTag) ?? {
      owner: ownerTag,
      openNow: 0,
      createdInWindow: 0,
      completedInWindow: 0
    };

    const projectTags = tags.filter((tag) => tag.startsWith("project:"));
    const normalizedProjectTags = projectTags.length > 0 ? projectTags : ["project:unknown"];

    if (row.status === "open") {
      openNow += 1;
      ownerEntry.openNow += 1;
      for (const projectTag of normalizedProjectTags) {
        const projectEntry = projectBreakdown.get(projectTag) ?? {
          projectTag,
          openNow: 0,
          createdInWindow: 0,
          completedInWindow: 0
        };
        projectEntry.openNow += 1;
        projectBreakdown.set(projectTag, projectEntry);
      }
      if (row.dueDate && row.dueDate < endDate) {
        overdueOpen += 1;
      }
    }

    if (row.status === "done") {
      doneNow += 1;
    }

    if (createdDay && createdDay >= startDate && createdDay <= endDate) {
      createdInWindow += 1;
      ownerEntry.createdInWindow += 1;
      const point = daily.get(createdDay);
      if (point) {
        point.created += 1;
      }
      for (const projectTag of normalizedProjectTags) {
        const projectEntry = projectBreakdown.get(projectTag) ?? {
          projectTag,
          openNow: 0,
          createdInWindow: 0,
          completedInWindow: 0
        };
        projectEntry.createdInWindow += 1;
        projectBreakdown.set(projectTag, projectEntry);
      }
    }

    if (completedDay && completedDay >= startDate && completedDay <= endDate) {
      completedInWindow += 1;
      ownerEntry.completedInWindow += 1;
      const point = daily.get(completedDay);
      if (point) {
        point.completed += 1;
      }
      for (const projectTag of normalizedProjectTags) {
        const projectEntry = projectBreakdown.get(projectTag) ?? {
          projectTag,
          openNow: 0,
          createdInWindow: 0,
          completedInWindow: 0
        };
        projectEntry.completedInWindow += 1;
        projectBreakdown.set(projectTag, projectEntry);
      }
    }

    ownerBreakdown.set(ownerTag, ownerEntry);
  }

  const completionRateInWindow =
    createdInWindow > 0 ? Number((completedInWindow / createdInWindow).toFixed(3)) : 0;

  const sortByHighestCombinedActivity = <T extends { openNow: number; createdInWindow: number; completedInWindow: number }>(
    left: T,
    right: T
  ): number => {
    const leftCombined = left.openNow + left.createdInWindow + left.completedInWindow;
    const rightCombined = right.openNow + right.createdInWindow + right.completedInWindow;
    if (rightCombined !== leftCombined) {
      return rightCombined - leftCombined;
    }
    if (right.createdInWindow !== left.createdInWindow) {
      return right.createdInWindow - left.createdInWindow;
    }
    if (right.completedInWindow !== left.completedInWindow) {
      return right.completedInWindow - left.completedInWindow;
    }
    if (right.openNow !== left.openNow) {
      return right.openNow - left.openNow;
    }
    return 0;
  };

  return json({
    analytics: {
      schemaVersion: "2026-03-27",
      generatedAt: new Date().toISOString(),
      window: { days, startDate, endDate, timeZone },
      totals: {
        tasksVisible: rows.length,
        openNow,
        doneNow,
        overdueOpen,
        createdInWindow,
        completedInWindow,
        completionRateInWindow
      },
      daily: [...daily.values()],
      breakdowns: {
        owner: [...ownerBreakdown.values()].sort((left, right) => {
          const byTotals = sortByHighestCombinedActivity(left, right);
          if (byTotals !== 0) {
            return byTotals;
          }
          return left.owner.localeCompare(right.owner);
        }),
        project: [...projectBreakdown.values()].sort((left, right) => {
          const byTotals = sortByHighestCombinedActivity(left, right);
          if (byTotals !== 0) {
            return byTotals;
          }
          return left.projectTag.localeCompare(right.projectTag);
        })
      },
      guidance: {
        definitions: {
          createdInWindow: `Tasks with createdAt between ${startDate} and ${endDate}, inclusive.`,
          completedInWindow: `Tasks with completedAt between ${startDate} and ${endDate}, inclusive.`,
          completionRateInWindow: "completedInWindow / createdInWindow; returns 0 when createdInWindow is 0.",
          overdueOpen: "Open tasks where dueDate is before today in the selected timezone.",
          timeZone: `Window boundaries and daily aggregation use ${timeZone}.`,
          throughputStartAnchor: `Throughput analytics do not include days before ${ANALYTICS_THROUGHPUT_START_DATE}.`,
          tasksVisible: "All tasks the caller can read after list membership filtering."
        },
        interpretationHints: [
          "If createdInWindow consistently exceeds completedInWindow, backlog likely grows.",
          "If overdueOpen rises, prioritize aging and due-date hygiene.",
          "Owner and project breakdowns help route work and rebalance throughput."
        ]
      }
    }
  });
};

const updateTask = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  taskId: string,
  requestContext: RequestContext
): Promise<Response> => {
  const payload = await parseJsonBody<UpdateTaskInput>(request);
  if (!payload) {
    return error("invalid JSON body", 422);
  }

  let nextStatus: TaskStatus | undefined;

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
  if (payload.listId !== undefined) {
    const listId = payload.listId.trim();
    if (!listId) {
      return error("listId cannot be empty", 422);
    }
    updates.listId = listId;
  }
  if (payload.tags !== undefined) {
    const normalizedTags = normalizeTaskTags(payload.tags);
    if (payload.tags.length > 0 && !normalizedTags) {
      return error("tags must contain at least one non-empty value", 422);
    }
    const tagValidationError = validateRequiredCreateTaskTags(normalizedTags);
    if (tagValidationError) {
      return error(tagValidationError, 422);
    }
  }
  if (payload.status !== undefined) {
    if (payload.status !== "open" && payload.status !== "done") {
      return error("status must be open or done", 422);
    }
    nextStatus = payload.status;
    updates.status = payload.status;
  }
  if (Object.keys(updates).length === 1) {
    return error("no updates provided", 422);
  }

  const db = dbForEnv(env);
  const existingRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const existing = existingRows[0];
  if (!existing) {
    return error("task not found", 404);
  }
  const roleResult = await requireListRole(env, auth, existing.listId, "editor");
  if (roleResult instanceof Response) {
    return roleResult;
  }

  if (nextStatus) {
    updates.completedAt = nextStatus === "done" ? existing.completedAt ?? updates.updatedAt ?? new Date().toISOString() : null;
  }

  await db.update(tasks).set(updates).where(eq(tasks.id, taskId));
  if (payload.tags !== undefined) {
    await syncTaskTags(env, taskId, existing.userId, normalizeTaskTags(payload.tags));
  }
  const updated = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!updated[0]) {
    return error("task not found", 404);
  }
  const tagsByTaskId = await loadTaskTagsByTaskId(env, [taskId]);

  await writeAuditEvent(env, requestContext, "task.updated", auth.userId, "task", taskId, {
    fields: Object.keys(payload)
  });
  logInfo({
    event: "task.mutated",
    requestId: requestContext.requestId,
    method: requestContext.method,
    path: requestContext.path,
    userId: auth.userId,
    resourceType: "task",
    resourceId: taskId,
    status: 200,
    details: { action: "update", fields: Object.keys(payload) }
  });
  return json({ task: mapTask(updated[0], tagsByTaskId.get(taskId) ?? []) });
};

const completeTask = async (
  env: Env,
  auth: AuthContext,
  taskId: string,
  requestContext: RequestContext
): Promise<Response> => {
  const db = dbForEnv(env);
  const now = new Date().toISOString();

  const existingRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const existing = existingRows[0];
  if (!existing) {
    return error("task not found", 404);
  }
  const roleResult = await requireListRole(env, auth, existing.listId, "editor");
  if (roleResult instanceof Response) {
    return roleResult;
  }

  await db
    .update(tasks)
    .set({ status: "done", completedAt: now, updatedAt: now })
    .where(eq(tasks.id, taskId));

  const updated = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!updated[0]) {
    return error("task not found", 404);
  }
  const tagsByTaskId = await loadTaskTagsByTaskId(env, [taskId]);

  await writeAuditEvent(env, requestContext, "task.completed", auth.userId, "task", taskId, {
    status: "done"
  });
  logInfo({
    event: "task.mutated",
    requestId: requestContext.requestId,
    method: requestContext.method,
    path: requestContext.path,
    userId: auth.userId,
    resourceType: "task",
    resourceId: taskId,
    status: 200,
    details: { action: "complete" }
  });
  return json({ task: mapTask(updated[0], tagsByTaskId.get(taskId) ?? []) });
};

const deleteTask = async (env: Env, auth: AuthContext, taskId: string): Promise<Response> => {
  const db = dbForEnv(env);
  const existingRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const existing = existingRows[0];
  if (!existing) {
    return error("task not found", 404);
  }

  const roleResult = await requireListRole(env, auth, existing.listId, "editor");
  if (roleResult instanceof Response) {
    return roleResult;
  }

  await db.delete(taskTags).where(eq(taskTags.taskId, taskId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
  return json({ ok: true });
};

const createRecurrenceRule = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  requestContext: RequestContext
): Promise<Response> => {
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
  const listIdResult = await resolveWritableListId(env, auth, payload.listId);
  if (listIdResult instanceof Response) {
    return listIdResult;
  }

  await db.insert(recurrenceRules).values({
    id,
    userId: auth.userId,
    listId: listIdResult,
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
    .where(eq(recurrenceRules.id, id));
  if (!created[0]) {
    return error("failed to create recurrence rule", 500);
  }

  await writeAuditEvent(env, requestContext, "recurrence_rule.created", auth.userId, "recurrence_rule", id, {
    cadence: payload.cadence,
    interval,
    timezone
  });
  logInfo({
    event: "recurrence_rule.mutated",
    requestId: requestContext.requestId,
    method: requestContext.method,
    path: requestContext.path,
    userId: auth.userId,
    resourceType: "recurrence_rule",
    resourceId: id,
    status: 201,
    details: { action: "create" }
  });
  return json({ recurrenceRule: mapRule(created[0]) }, 201);
};

const listRecurrenceRules = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const url = new URL(request.url);
  const listId = url.searchParams.get("listId")?.trim() || null;

  let allowedListIds: string[];
  if (listId) {
    const roleResult = await requireListRole(env, auth, listId, "viewer");
    if (roleResult instanceof Response) {
      return roleResult;
    }
    allowedListIds = [listId];
  } else {
    allowedListIds = await listIdsForMember(env, auth.userId, "viewer");
  }

  if (allowedListIds.length === 0) {
    return json({ recurrenceRules: [] });
  }

  const rows = await db
    .select()
    .from(recurrenceRules)
    .where(and(inArray(recurrenceRules.listId, allowedListIds), eq(recurrenceRules.active, true)))
    .orderBy(asc(recurrenceRules.nextRunDate), asc(recurrenceRules.id));

  return json({ recurrenceRules: rows.map(mapRule) });
};

const updateRecurrenceRule = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  ruleId: string,
  requestContext: RequestContext
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
  const existingRows = await db.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  const existing = existingRows[0];
  if (!existing) {
    return error("recurrence rule not found", 404);
  }

  const roleResult = await requireListRole(env, auth, existing.listId, "editor");
  if (roleResult instanceof Response) {
    return roleResult;
  }

  await db
    .update(recurrenceRules)
    .set(updates)
    .where(eq(recurrenceRules.id, ruleId));

  const updated = await db.select().from(recurrenceRules).where(eq(recurrenceRules.id, ruleId));
  if (!updated[0]) {
    return error("recurrence rule not found", 404);
  }

  await writeAuditEvent(env, requestContext, "recurrence_rule.updated", auth.userId, "recurrence_rule", ruleId, {
    fields: Object.keys(payload)
  });
  logInfo({
    event: "recurrence_rule.mutated",
    requestId: requestContext.requestId,
    method: requestContext.method,
    path: requestContext.path,
    userId: auth.userId,
    resourceType: "recurrence_rule",
    resourceId: ruleId,
    status: 200,
    details: { action: "update", fields: Object.keys(payload) }
  });

  return json({ recurrenceRule: mapRule(updated[0]) });
};

const materializeRecurrences = async (
  env: Env,
  onDate?: string,
  actorUserId?: string,
  requestContext?: RequestContext
): Promise<{ created: number; rulesProcessed: number }> => {
  const db = dbForEnv(env);
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const writableListIds = actorUserId ? await listIdsForMember(env, actorUserId, "editor") : null;
  if (actorUserId && writableListIds && writableListIds.length === 0) {
    return { created: 0, rulesProcessed: 0 };
  }

  const materializationFilter = writableListIds
    ? and(inArray(recurrenceRules.listId, writableListIds), eq(recurrenceRules.active, true))
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
            listId: rule.listId,
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
      .where(eq(recurrenceRules.id, rule.id));
  }

  if (requestContext) {
    logInfo({
      event: "recurrence.materialization.run",
      requestId: requestContext.requestId,
      method: requestContext.method,
      path: requestContext.path,
      ...(actorUserId ? { userId: actorUserId } : {}),
      status: 200,
      details: {
        created,
        rulesProcessed,
        targetDate: onDate ?? null
      }
    });
  }

  return { created, rulesProcessed };
};

const runMaterialization = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  requestContext: RequestContext
): Promise<Response> =>
  withIdempotency(request, env, auth, async () => {
    const body = await parseJsonBody<{ date?: string }>(request);
    if (body?.date && !isValidIsoDate(body.date)) {
      return error("date must be YYYY-MM-DD", 422);
    }
    const result = await materializeRecurrences(env, body?.date, auth.userId, requestContext);
    return json({ ok: true, ...result });
  });

const createList = async (request: Request, env: Env, auth: AuthContext): Promise<Response> => {
  const payload = await parseJsonBody<CreateListInput>(request);
  const name = payload?.name?.trim();
  if (!name) {
    return error("name is required", 422);
  }

  const db = dbForEnv(env);
  const now = new Date().toISOString();
  const listId = crypto.randomUUID();
  await db.insert(lists).values({
    id: listId,
    name,
    createdByUserId: auth.userId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(listMemberships).values({
    listId,
    userId: auth.userId,
    role: "owner",
    createdAt: now,
    updatedAt: now
  });

  const [createdList] = await db.select().from(lists).where(eq(lists.id, listId));
  const [createdMembership] = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, auth.userId)));
  if (!createdList || !createdMembership) {
    return error("failed to create list", 500);
  }

  return json({ list: mapList(createdList, createdMembership) }, 201);
};

const listLists = async (env: Env, auth: AuthContext): Promise<Response> => {
  const db = dbForEnv(env);
  const rows = await db
    .select({ list: lists, membership: listMemberships })
    .from(listMemberships)
    .innerJoin(lists, eq(lists.id, listMemberships.listId))
    .where(eq(listMemberships.userId, auth.userId))
    .orderBy(asc(lists.createdAt), asc(lists.id));
  return json({ lists: rows.map((row) => mapList(row.list, row.membership)) });
};

const listListMemberships = async (env: Env, auth: AuthContext, listId: string): Promise<Response> => {
  const roleResult = await requireListRole(env, auth, listId, "viewer");
  if (roleResult instanceof Response) {
    return roleResult;
  }

  const db = dbForEnv(env);
  const rows = await db
    .select()
    .from(listMemberships)
    .where(eq(listMemberships.listId, listId))
    .orderBy(asc(listMemberships.createdAt), asc(listMemberships.userId));
  return json({ memberships: rows.map(mapMembership) });
};

const upsertListMembership = async (
  request: Request,
  env: Env,
  auth: AuthContext,
  listId: string,
  memberUserId: string
): Promise<Response> => {
  const ownerRoleResult = await requireListRole(env, auth, listId, "owner");
  if (ownerRoleResult instanceof Response) {
    return ownerRoleResult;
  }

  const payload = await parseJsonBody<UpsertListMembershipInput>(request);
  if (!payload || !isListRole(payload.role)) {
    return error("role must be owner, editor, or viewer", 422);
  }

  const db = dbForEnv(env);
  const existingUser = await db.select({ id: users.id }).from(users).where(eq(users.id, memberUserId)).limit(1);
  if (!existingUser[0]) {
    return error("user not found", 404);
  }

  const now = new Date().toISOString();
  const existingMembership = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, memberUserId)));

  if (existingMembership[0]) {
    await db
      .update(listMemberships)
      .set({ role: payload.role, updatedAt: now })
      .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, memberUserId)));
  } else {
    await db.insert(listMemberships).values({
      listId,
      userId: memberUserId,
      role: payload.role,
      createdAt: now,
      updatedAt: now
    });
  }

  const [membership] = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, memberUserId)));
  if (!membership) {
    return error("membership not found", 404);
  }
  return json({ membership: mapMembership(membership) });
};

const removeListMembership = async (
  env: Env,
  auth: AuthContext,
  listId: string,
  memberUserId: string
): Promise<Response> => {
  const ownerRoleResult = await requireListRole(env, auth, listId, "owner");
  if (ownerRoleResult instanceof Response) {
    return ownerRoleResult;
  }

  const db = dbForEnv(env);
  const existingRows = await db
    .select()
    .from(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, memberUserId)));
  if (!existingRows[0]) {
    return error("membership not found", 404);
  }

  await db
    .delete(listMemberships)
    .where(and(eq(listMemberships.listId, listId), eq(listMemberships.userId, memberUserId)));
  return json({ ok: true });
};

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

const routeListId = (pathname: string): string | null => {
  const match = pathname.match(/^\/lists\/([^/]+)\/memberships$/);
  if (!match || !match[1]) {
    return null;
  }
  return decodeURIComponent(match[1]);
};

const routeListMembershipId = (pathname: string): { listId: string; userId: string } | null => {
  const match = pathname.match(/^\/lists\/([^/]+)\/memberships\/([^/]+)$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return { listId: decodeURIComponent(match[1]), userId: decodeURIComponent(match[2]) };
};

const handleApiFetch = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === "/health" && request.method === "GET") {
    return withRequestIdHeader(json({ ok: true }), requestContext.requestId);
  }

  const authResult = await requireBearerAuth(request, env, requestContext);
  if (authResult instanceof Response) {
    return withRequestIdHeader(authResult, requestContext.requestId);
  }
  const auth = authResult;

  if (pathname === "/tasks" && request.method === "POST") {
    return withRequestIdHeader(
      await withIdempotency(request, env, auth, () => createTask(request, env, auth, requestContext)),
      requestContext.requestId
    );
  }
  if (pathname === "/tasks" && request.method === "GET") {
    return withRequestIdHeader(await listTasks(request, env, auth), requestContext.requestId);
  }
  if (pathname === "/analytics/overview" && request.method === "GET") {
    return withRequestIdHeader(await analyticsOverview(request, env, auth), requestContext.requestId);
  }

  const taskRoute = routeTaskId(pathname);
  if (taskRoute && request.method === "PATCH" && !taskRoute.complete) {
    return withRequestIdHeader(
      await updateTask(request, env, auth, taskRoute.taskId, requestContext),
      requestContext.requestId
    );
  }
  if (taskRoute && request.method === "POST" && taskRoute.complete) {
    return withRequestIdHeader(await completeTask(env, auth, taskRoute.taskId, requestContext), requestContext.requestId);
  }
  if (taskRoute && request.method === "DELETE" && !taskRoute.complete) {
    return withRequestIdHeader(await deleteTask(env, auth, taskRoute.taskId), requestContext.requestId);
  }

  if (pathname === "/recurrence-rules" && request.method === "POST") {
    return withRequestIdHeader(await createRecurrenceRule(request, env, auth, requestContext), requestContext.requestId);
  }
  if (pathname === "/recurrence-rules" && request.method === "GET") {
    return withRequestIdHeader(await listRecurrenceRules(request, env, auth), requestContext.requestId);
  }

  if (pathname === "/lists" && request.method === "POST") {
    return withRequestIdHeader(await createList(request, env, auth), requestContext.requestId);
  }
  if (pathname === "/lists" && request.method === "GET") {
    return withRequestIdHeader(await listLists(env, auth), requestContext.requestId);
  }

  const recurrenceRuleId = routeRecurrenceRuleId(pathname);
  if (recurrenceRuleId && request.method === "PATCH") {
    return withRequestIdHeader(
      await updateRecurrenceRule(request, env, auth, recurrenceRuleId, requestContext),
      requestContext.requestId
    );
  }

  if (pathname === "/jobs/materialize-recurrence" && request.method === "POST") {
    return withRequestIdHeader(await runMaterialization(request, env, auth, requestContext), requestContext.requestId);
  }

  const membershipsListId = routeListId(pathname);
  if (membershipsListId && request.method === "GET") {
    return withRequestIdHeader(await listListMemberships(env, auth, membershipsListId), requestContext.requestId);
  }

  const membershipPath = routeListMembershipId(pathname);
  if (membershipPath && request.method === "PUT") {
    return withRequestIdHeader(
      await upsertListMembership(request, env, auth, membershipPath.listId, membershipPath.userId),
      requestContext.requestId
    );
  }
  if (membershipPath && request.method === "DELETE") {
    return withRequestIdHeader(
      await removeListMembership(env, auth, membershipPath.listId, membershipPath.userId),
      requestContext.requestId
    );
  }

  return withRequestIdHeader(error("not found", 404), requestContext.requestId);
};

const uiSessionStatus = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> =>
  withRequestIdHeader(json({ authenticated: await hasValidUiSession(request, env) }), requestContext.requestId);

const uiSessionLogin = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> => {
  if (!env.WEB_UI_PASSWORD_HASH) {
    return withRequestIdHeader(error("WEB_UI_PASSWORD_HASH is not configured", 500), requestContext.requestId);
  }
  const payload = await parseJsonBody<{ password?: string }>(request);
  const password = payload?.password?.trim() ?? "";
  if (!password) {
    return withRequestIdHeader(error("password is required", 422), requestContext.requestId);
  }

  const providedHash = await sha256Hex(password);
  if (!timingSafeEqual(providedHash, env.WEB_UI_PASSWORD_HASH)) {
    return withRequestIdHeader(error("invalid password", 401), requestContext.requestId);
  }

  const sessionCookie = await issueUiSessionCookie(env);
  if (!sessionCookie) {
    return withRequestIdHeader(error("WEB_UI_SESSION_SECRET is not configured", 500), requestContext.requestId);
  }

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("set-cookie", sessionCookie);
  headers.set(REQUEST_ID_HEADER, requestContext.requestId);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

const uiSessionLogout = (requestContext: RequestContext): Response => {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("set-cookie", clearUiSessionCookie());
  headers.set(REQUEST_ID_HEADER, requestContext.requestId);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};

const uiMe = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> => {
  if (!(await hasValidUiSession(request, env))) {
    return withRequestIdHeader(error("unauthorized", 401), requestContext.requestId);
  }
  return withRequestIdHeader(json({ token: env.WEB_UI_BEARER_TOKEN ?? null }), requestContext.requestId);
};

const uiApiProxy = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> => {
  if (!(await hasValidUiSession(request, env))) {
    return withRequestIdHeader(error("unauthorized", 401), requestContext.requestId);
  }
  if (!env.WEB_UI_BEARER_TOKEN) {
    return withRequestIdHeader(error("WEB_UI_BEARER_TOKEN is not configured", 500), requestContext.requestId);
  }

  const sourceUrl = new URL(request.url);
  const proxiedPath = sourceUrl.pathname.replace(/^\/ui\/api/, "") || "/";
  const targetUrl = new URL(sourceUrl.toString());
  targetUrl.pathname = proxiedPath;

  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set("authorization", `Bearer ${env.WEB_UI_BEARER_TOKEN}`);
  proxyHeaders.delete("cookie");

  const proxiedInit: RequestInit = {
    method: request.method,
    headers: proxyHeaders
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    proxiedInit.body = await request.arrayBuffer();
  }
  const proxiedRequest = new Request(targetUrl.toString(), proxiedInit);

  return handleApiFetch(proxiedRequest, env, requestContext);
};

const handleFetch = async (request: Request, env: Env, requestContext: RequestContext): Promise<Response> => {
  const { pathname } = new URL(request.url);
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const isUiPageRoute =
    normalizedPath === "/" ||
    normalizedPath === "/index.html" ||
    normalizedPath === "/analytics" ||
    normalizedPath === "/settings" ||
    normalizedPath === "/user";

  if (pathname === "/favicon.ico") {
    return withRequestIdHeader(new Response(null, { status: 204 }), requestContext.requestId);
  }

  if (pathname === "/ui/session" && request.method === "GET") {
    return uiSessionStatus(request, env, requestContext);
  }
  if (pathname === "/ui/session" && request.method === "POST") {
    return uiSessionLogin(request, env, requestContext);
  }
  if (pathname === "/ui/session" && request.method === "DELETE") {
    return uiSessionLogout(requestContext);
  }
  if (pathname === "/ui/me" && request.method === "GET") {
    return uiMe(request, env, requestContext);
  }
  if (pathname.startsWith("/ui/api/")) {
    return uiApiProxy(request, env, requestContext);
  }
  if (isUiPageRoute || pathname.startsWith("/assets/")) {
    return withRequestIdHeader(await serveUiAsset(request, env), requestContext.requestId);
  }
  if (pathname === "/app" || pathname === "/app/" || pathname.startsWith("/app/")) {
    return withRequestIdHeader(new Response(null, { status: 307, headers: { location: "/" } }), requestContext.requestId);
  }

  return handleApiFetch(request, env, requestContext);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestContext = toRequestContext(request);
    try {
      return await handleFetch(request, env, requestContext);
    } catch (caughtError) {
      const errorToLog =
        caughtError instanceof Error
          ? caughtError
          : new Error(typeof caughtError === "string" ? caughtError : "unknown worker error");
      logError({
        event: "request.error",
        requestId: requestContext.requestId,
        method: requestContext.method,
        path: requestContext.path,
        status: 500,
        error: {
          name: errorToLog.name,
          message: errorToLog.message
        }
      });
      return withRequestIdHeader(error("internal server error", 500), requestContext.requestId);
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const requestContext: RequestContext = {
      requestId: crypto.randomUUID(),
      method: "SCHEDULED",
      path: "/jobs/materialize-recurrence"
    };
    ctx.waitUntil(materializeRecurrences(env, undefined, undefined, requestContext));
  }
};
