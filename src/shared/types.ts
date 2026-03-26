export type TaskStatus = "open" | "done";

export type Cadence = "daily" | "weekly";

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
}

export interface UpdateTaskInput {
  title?: string;
  note?: string;
  dueDate?: string | null;
}

export interface CreateRecurrenceRuleInput {
  titleTemplate: string;
  noteTemplate?: string;
  cadence: Cadence;
  interval?: number;
  weekdays?: number[];
  timezone?: string;
  anchorDate?: string;
  exceptionDates?: string[];
  listId?: string;
}

export interface UpdateRecurrenceRuleInput {
  timezone?: string;
  exceptionDates?: string[];
  active?: boolean;
  nextRunDate?: string;
}

export interface TaskDTO {
  id: string;
  listId: string;
  title: string;
  note: string | null;
  status: TaskStatus;
  dueDate: string | null;
  recurrenceRuleId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RecurrenceRuleDTO {
  id: string;
  listId: string;
  titleTemplate: string;
  noteTemplate: string | null;
  cadence: Cadence;
  interval: number;
  weekdays: number[] | null;
  timezone: string;
  anchorDate: string;
  nextRunDate: string;
  exceptionDates: string[] | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
