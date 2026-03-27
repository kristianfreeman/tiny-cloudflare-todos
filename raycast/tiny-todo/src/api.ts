import { getPreferenceValues } from "@raycast/api";

export interface TodoTask {
  id: string;
  title: string;
  note: string | null;
  tags: string[];
  status: "open" | "done";
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskListResponse {
  tasks: TodoTask[];
}

interface CreateTaskInput {
  title: string;
  note?: string;
  dueDate?: string;
  tags?: string[];
}

interface UpdateTaskInput {
  status?: "open" | "done";
}

export type TaskStatus = "open" | "done" | "all";

interface Preferences {
  apiBaseUrl: string;
  apiToken: string;
  defaultStatus?: TaskStatus;
  defaultOwnerScope?: OwnerScope;
}

export type OwnerScope = "all" | "user" | "agent";

interface ErrorResponse {
  error?: string;
}

const normalizeTaskTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
};

const normalizeTask = (task: TodoTask): TodoTask => ({
  ...task,
  tags: normalizeTaskTags(task.tags),
});

const normalizeApiBaseUrl = (value: string): string =>
  value.replace(/\/+$/, "");

const getApiConfig = (): { apiBaseUrl: string; apiToken: string } => {
  const preferences = getPreferenceValues<Preferences>();
  return {
    apiBaseUrl: normalizeApiBaseUrl(preferences.apiBaseUrl),
    apiToken: preferences.apiToken,
  };
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // ignore JSON parse failures and fall through to status message
  }

  return `Request failed with ${response.status}`;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const { apiBaseUrl, apiToken } = getApiConfig();
  const url = `${apiBaseUrl}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as T;
};

export const getDefaultStatusFilter = (): TaskStatus => {
  const preferences = getPreferenceValues<Preferences>();
  if (
    preferences.defaultStatus === "done" ||
    preferences.defaultStatus === "all"
  ) {
    return preferences.defaultStatus;
  }

  return "open";
};

export const getDefaultOwnerScope = (): OwnerScope => {
  const preferences = getPreferenceValues<Preferences>();
  if (
    preferences.defaultOwnerScope === "user" ||
    preferences.defaultOwnerScope === "agent"
  ) {
    return preferences.defaultOwnerScope;
  }

  return "all";
};

export const listTasks = async (
  status: TaskStatus,
  tags?: string[],
): Promise<TodoTask[]> => {
  const query = new URLSearchParams({ status, limit: "200" });
  if (tags && tags.length > 0) {
    query.set("tag", tags.join(","));
  }
  const response = await request<TaskListResponse>(
    `/tasks?${query.toString()}`,
  );
  return response.tasks.map(normalizeTask);
};

export const createTask = async (input: CreateTaskInput): Promise<TodoTask> => {
  const response = await request<{ task: TodoTask }>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return normalizeTask(response.task);
};

export const completeTask = async (taskId: string): Promise<TodoTask> => {
  const encodedId = encodeURIComponent(taskId);
  const response = await request<{ task: TodoTask }>(
    `/tasks/${encodedId}/complete`,
    {
      method: "POST",
    },
  );
  return normalizeTask(response.task);
};

export const reopenTask = async (taskId: string): Promise<TodoTask> => {
  const encodedId = encodeURIComponent(taskId);
  const response = await request<{ task: TodoTask }>(`/tasks/${encodedId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "open" } satisfies UpdateTaskInput),
  });
  return normalizeTask(response.task);
};
