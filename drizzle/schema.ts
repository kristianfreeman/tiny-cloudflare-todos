import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull()
});

export const lists = sqliteTable("lists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const listMemberships = sqliteTable(
  "list_memberships",
  {
    listId: text("list_id")
      .notNull()
      .references(() => lists.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").$type<"owner" | "editor" | "viewer">().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.listId, table.userId] })]
);

export const recurrenceRules = sqliteTable("recurrence_rules", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  listId: text("list_id")
    .notNull()
    .references(() => lists.id),
  titleTemplate: text("title_template").notNull(),
  noteTemplate: text("note_template"),
  cadence: text("cadence").notNull(),
  interval: integer("interval").notNull().default(1),
  weekdays: text("weekdays", { mode: "json" }).$type<number[] | null>(),
  tags: text("tags", { mode: "json" }).$type<string[] | null>(),
  dayOfMonth: integer("day_of_month"),
  generationPolicy: text("generation_policy").notNull().default("calendar"),
  timezone: text("timezone").notNull().default("UTC"),
  anchorDate: text("anchor_date").notNull(),
  nextRunDate: text("next_run_date").notNull(),
  exceptionDates: text("exception_dates", { mode: "json" }).$type<string[] | null>(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  listId: text("list_id")
    .notNull()
    .references(() => lists.id),
  title: text("title").notNull(),
  note: text("note"),
  status: text("status").notNull().default("open"),
  dueDate: text("due_date"),
  recurrenceRuleId: text("recurrence_rule_id").references(() => recurrenceRules.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at")
});

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tag: text("tag").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.taskId, table.tag] })]
);

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.idempotencyKey, table.method, table.path] })]
);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => users.id),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  requestId: text("request_id").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: text("created_at").notNull()
});

export type TaskRow = typeof tasks.$inferSelect;
export type RecurrenceRuleRow = typeof recurrenceRules.$inferSelect;
export type IdempotencyRecordRow = typeof idempotencyRecords.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type ListRow = typeof lists.$inferSelect;
export type ListMembershipRow = typeof listMemberships.$inferSelect;
export type TaskTagRow = typeof taskTags.$inferSelect;
