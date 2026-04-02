export type TaskStatus = "open" | "done";

export type Cadence = "daily" | "weekly" | "monthly";

export type RecurrenceGenerationPolicy = "calendar" | "completion";

export type ListRole = "owner" | "editor" | "viewer";

export interface CreateListInput {
  name: string;
}

export interface ListDTO {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  myRole: ListRole;
}

export interface ListMembershipDTO {
  listId: string;
  userId: string;
  role: ListRole;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertListMembershipInput {
  role: ListRole;
}

export interface CreateTaskInput {
  title: string;
  note?: string;
  dueDate?: string;
  listId?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  note?: string | null;
  dueDate?: string | null;
  listId?: string;
  tags?: string[];
  status?: TaskStatus;
}

export type TaskSort =
  | "default"
  | "due_date_asc"
  | "due_date_desc"
  | "created_at_asc"
  | "created_at_desc"
  | "completed_at_desc";

export interface ListTasksQuery {
  status?: "open" | "done" | "all";
  limit?: number;
  offset?: number;
  search?: string;
  dueBefore?: string;
  dueAfter?: string;
  listId?: string;
  sort?: TaskSort;
  tag?: string;
}

export interface CreateRecurrenceRuleInput {
  titleTemplate: string;
  noteTemplate?: string;
  cadence: Cadence;
  interval?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  timezone?: string;
  anchorDate?: string;
  exceptionDates?: string[];
  generationPolicy?: RecurrenceGenerationPolicy;
  tags?: string[];
  listId?: string;
}

export interface UpdateRecurrenceRuleInput {
  timezone?: string;
  exceptionDates?: string[];
  active?: boolean;
  nextRunDate?: string;
  dayOfMonth?: number | null;
  generationPolicy?: RecurrenceGenerationPolicy;
  tags?: string[];
}

export interface TaskDTO {
  id: string;
  listId: string;
  title: string;
  note: string | null;
  tags: string[];
  status: TaskStatus;
  dueDate: string | null;
  recurrenceRuleId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ListTasksResponse {
  tasks: TaskDTO[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface RecurrenceRuleDTO {
  id: string;
  listId: string;
  titleTemplate: string;
  noteTemplate: string | null;
  cadence: Cadence;
  interval: number;
  weekdays: number[] | null;
  dayOfMonth: number | null;
  timezone: string;
  anchorDate: string;
  nextRunDate: string;
  exceptionDates: string[] | null;
  generationPolicy: RecurrenceGenerationPolicy;
  tags: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
