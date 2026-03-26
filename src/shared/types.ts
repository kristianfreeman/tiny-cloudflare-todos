export type TaskStatus = "open" | "done";

export type Cadence = "daily" | "weekly";

export interface CreateTaskInput {
  title: string;
  note?: string;
  dueDate?: string;
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
}

export interface UpdateRecurrenceRuleInput {
  timezone?: string;
  exceptionDates?: string[];
  active?: boolean;
  nextRunDate?: string;
}

export interface TaskDTO {
  id: string;
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
