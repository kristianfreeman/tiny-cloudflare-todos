import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  ChartBar,
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  Robot,
  SignOut,
  Tag,
  Trash,
  User,
  UserCircle
} from "@phosphor-icons/react";
import { Badge, Button, ClipboardText, Input, SensitiveInput, Tabs } from "@cloudflare/kumo";

interface Task {
  id: string;
  title: string;
  note: string | null;
  tags: string[];
  dueDate: string | null;
  status: "open" | "done";
  createdAt: string;
  completedAt: string | null;
}

interface TasksResponse {
  tasks: Task[];
}

interface TaskGroup {
  tag: string;
  tasks: Task[];
}

interface AnalyticsDailyPoint {
  date: string;
  created: number;
  completed: number;
}

interface AnalyticsOwnerBreakdown {
  owner: string;
  openNow: number;
  createdInWindow: number;
  completedInWindow: number;
}

interface AnalyticsProjectBreakdown {
  projectTag: string;
  openNow: number;
  createdInWindow: number;
  completedInWindow: number;
}

interface AnalyticsResponse {
  analytics: {
    generatedAt: string;
    window: {
      days: number;
      startDate: string;
      endDate: string;
    };
    totals: {
      tasksVisible: number;
      openNow: number;
      doneNow: number;
      overdueOpen: number;
      createdInWindow: number;
      completedInWindow: number;
      completionRateInWindow: number;
    };
    daily: AnalyticsDailyPoint[];
    breakdowns: {
      owner: AnalyticsOwnerBreakdown[];
      project: AnalyticsProjectBreakdown[];
    };
  };
}

type Page = "tasks" | "analytics" | "user";

const readError = async (response: Response): Promise<string> => {
  const fallback = `Request failed (${response.status})`;
  try {
    const parsed = (await response.json()) as { error?: string };
    return parsed.error ?? fallback;
  } catch {
    return fallback;
  }
};

const groupTasksByTag = (tasks: Task[]): TaskGroup[] => {
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    const tags = task.tags.filter((tag) => !tag.startsWith("owner:"));
    const groupingTags = tags.length > 0 ? tags : ["untagged"];
    for (const tag of groupingTags) {
      const key = tag.trim() || "untagged";
      const existing = grouped.get(key);
      if (existing) {
        existing.push(task);
      } else {
        grouped.set(key, [task]);
      }
    }
  }

  const tagRank = (tag: string): number => {
    if (tag.startsWith("project:")) {
      return 0;
    }
    if (tag === "untagged") {
      return 2;
    }
    return 1;
  };

  return [...grouped.entries()]
    .sort((left, right) => {
      const rankDiff = tagRank(left[0]) - tagRank(right[0]);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([tag, groupedTasks]) => ({ tag, tasks: groupedTasks }));
};

const dayLabel = (isoDay: string): string => {
  const parsed = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDay;
  }
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function App() {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNote, setTaskNote] = useState("");
  const [taskTags, setTaskTags] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<Page>("tasks");
  const [token, setToken] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsResponse["analytics"] | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const openTasks = useMemo(() => tasks.filter((task) => task.status === "open"), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.status === "done"), [tasks]);
  const openGroups = useMemo(() => groupTasksByTag(openTasks), [openTasks]);
  const doneGroups = useMemo(() => groupTasksByTag(doneTasks), [doneTasks]);
  const analyticsDays = 30;
  const dailyMetrics = analytics?.daily ?? [];
  const analyticsOwnerBreakdown = analytics?.breakdowns.owner ?? [];
  const analyticsProjectBreakdown = analytics?.breakdowns.project ?? [];
  const maxDailyMetric = useMemo(
    () => Math.max(1, ...dailyMetrics.map((point) => Math.max(point.created, point.completed))),
    [dailyMetrics]
  );

  const loadSession = async (): Promise<void> => {
    const response = await fetch("/ui/session", { method: "GET" });
    if (!response.ok) {
      setAuthenticated(false);
      setSessionChecked(true);
      return;
    }
    const payload = (await response.json()) as { authenticated: boolean };
    setAuthenticated(payload.authenticated);
    setSessionChecked(true);
  };

  const loadTasks = async (): Promise<void> => {
    setLoadingTasks(true);
    const response = await fetch("/ui/api/tasks?status=all", { method: "GET" });
    if (!response.ok) {
      setTaskError(await readError(response));
      setLoadingTasks(false);
      return;
    }
    const payload = (await response.json()) as TasksResponse;
    setTasks(payload.tasks);
    setTaskError(null);
    setLoadingTasks(false);
  };

  const loadMe = async (): Promise<void> => {
    const response = await fetch("/ui/me", { method: "GET" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { token: string | null };
    setToken(payload.token);
  };

  const loadAnalytics = async (): Promise<void> => {
    setLoadingAnalytics(true);
    const response = await fetch(`/ui/api/analytics/overview?days=${analyticsDays}`, { method: "GET" });
    if (!response.ok) {
      setAnalyticsError(await readError(response));
      setLoadingAnalytics(false);
      return;
    }
    const payload = (await response.json()) as AnalyticsResponse;
    setAnalytics(payload.analytics);
    setAnalyticsError(null);
    setLoadingAnalytics(false);
  };

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void loadTasks();
    void loadAnalytics();
    void loadMe();
  }, [authenticated]);

  const login = async (): Promise<void> => {
    const response = await fetch("/ui/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      setPasswordError(await readError(response));
      return;
    }
    setPassword("");
    setPasswordError(null);
    setAuthenticated(true);
  };

  const logout = async (): Promise<void> => {
    await fetch("/ui/session", { method: "DELETE" });
    setAuthenticated(false);
    setTaskError(null);
    setAnalyticsError(null);
    setTasks([]);
    setAnalytics(null);
  };

  const createTask = async (): Promise<void> => {
    if (!taskTitle.trim()) {
      setTaskError("Title is required.");
      return;
    }

    const parsedTags = taskTags
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const response = await fetch("/ui/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: taskTitle.trim(),
        note: taskNote.trim() || undefined,
        dueDate: taskDueDate || undefined,
        tags: parsedTags.length > 0 ? parsedTags : undefined
      })
    });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    setTaskTitle("");
    setTaskNote("");
    setTaskTags("");
    setTaskDueDate("");
    await Promise.all([loadTasks(), loadAnalytics()]);
  };

  const completeTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}/complete`, { method: "POST" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await Promise.all([loadTasks(), loadAnalytics()]);
  };

  const updateTaskTitle = async (task: Task, title: string): Promise<void> => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === task.title) {
      return;
    }
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed })
    });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await Promise.all([loadTasks(), loadAnalytics()]);
  };

  const deleteTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await loadTasks();
  };

  const ownerOfTask = (task: Task): "agent" | "user" | null => {
    if (task.tags.includes("owner:agent")) {
      return "agent";
    }
    if (task.tags.includes("owner:user")) {
      return "user";
    }
    return null;
  };

  const renderTaskRow = (task: Task) => {
    const owner = ownerOfTask(task);
    const ownerTitle = owner === "agent" ? "Agent-owned" : owner === "user" ? "User-owned" : "Unknown owner";
    return (
      <li className="task-item" key={task.id}>
        <span className="owner-icon" title={ownerTitle}>
          {owner === "agent" ? <Robot size={16} weight="fill" /> : <User size={16} weight="fill" />}
        </span>
        <Input
          defaultValue={task.title}
          disabled={task.status === "done"}
          onBlur={(event: ChangeEvent<HTMLInputElement>) => void updateTaskTitle(task, event.currentTarget.value)}
        />
        <span className="task-meta">{task.dueDate ?? "No due date"}</span>
        <div className="task-item-actions">
          {task.status === "open" ? (
            <Button onClick={() => void completeTask(task.id)}>
              <CheckCircle size={16} weight="bold" />
              Complete
            </Button>
          ) : null}
          <Button onClick={() => void deleteTask(task.id)}>
            <Trash size={16} weight="bold" />
            Delete
          </Button>
        </div>
      </li>
    );
  };

  if (!sessionChecked) {
    return <main className="app-shell">Checking session...</main>;
  }

  if (!authenticated) {
    return (
      <main className="app-shell app-auth-shell">
        <section className="card auth-card">
          <h1 className="title">Tiny Todo Web</h1>
          <div className="auth-form">
            <Input
              type="password"
              value={password}
              placeholder="UI password"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
            />
            <Button onClick={() => void login()}>Unlock</Button>
          </div>
          {passwordError ? <p className="error-text">{passwordError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="card">
        <h1 className="title">Tiny Todo Dashboard</h1>
        <div className="badge-row">
          <Badge>
            <Circle size={14} weight="fill" />
            {openTasks.length} open
          </Badge>
          <Badge>
            <CheckCircle size={14} weight="fill" />
            {doneTasks.length} closed
          </Badge>
        </div>
        <div className="top-controls">
          <Tabs
            tabs={[
              { value: "tasks", label: "Tasks" },
              { value: "analytics", label: "Analytics" },
              { value: "user", label: "User" }
            ]}
            value={activePage}
            onValueChange={(value) => setActivePage(value as Page)}
          />
          <Button onClick={() => void logout()}>
            <SignOut size={16} weight="bold" />
            Logout
          </Button>
        </div>
      </section>

      {activePage === "tasks" ? (
        <section className="card tasks-panel">
          <h2>Create task</h2>
          <div className="task-create-grid">
            <Input
              placeholder="Task title"
              value={taskTitle}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTitle(event.currentTarget.value)}
            />
            <Input
              placeholder="Task note"
              value={taskNote}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskNote(event.currentTarget.value)}
            />
            <Input
              placeholder="tags (comma separated)"
              value={taskTags}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTags(event.currentTarget.value)}
            />
            <Input
              type="date"
              value={taskDueDate}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskDueDate(event.currentTarget.value)}
            />
            <Button onClick={() => void createTask()}>Add task</Button>
          </div>

          <div className="section-head">
            <h2>Open</h2>
            {loadingTasks ? <span className="task-meta">Loading...</span> : null}
          </div>
          {taskError ? <p className="error-text">{taskError}</p> : null}

          <div className="tag-grid">
            {openGroups.map((group) => (
              <section className="tag-group" key={`open-${group.tag}`}>
                <header className="tag-head">
                  <span className="tag-label">
                    <Tag size={14} weight="bold" />
                    {group.tag}
                  </span>
                  <Badge>{group.tasks.length}</Badge>
                </header>
                <ul className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</ul>
              </section>
            ))}
            {openGroups.length === 0 ? <p className="task-meta">No open tasks.</p> : null}
          </div>

          <div className="section-head">
            <h2>Closed</h2>
            <Button onClick={() => setShowClosed((value) => !value)}>
              {showClosed ? <CaretDown size={16} weight="bold" /> : <CaretRight size={16} weight="bold" />}
              {showClosed ? "Hide" : "Show"} closed ({doneTasks.length})
            </Button>
          </div>
          {showClosed ? (
            <div className="tag-grid">
              {doneGroups.map((group) => (
                <section className="tag-group tag-group-closed" key={`done-${group.tag}`}>
                  <header className="tag-head">
                    <span className="tag-label">
                      <Tag size={14} weight="bold" />
                      {group.tag}
                    </span>
                    <Badge>{group.tasks.length}</Badge>
                  </header>
                  <ul className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</ul>
                </section>
              ))}
              {doneGroups.length === 0 ? <p className="task-meta">No closed tasks.</p> : null}
            </div>
          ) : null}
        </section>
      ) : activePage === "analytics" ? (
        <section className="card analytics-page">
          <header className="section-head analytics-head">
            <h2>
              <ChartBar size={18} weight="fill" /> Analytics ({analyticsDays} days)
            </h2>
            {loadingAnalytics ? <span className="task-meta">Loading...</span> : null}
          </header>
          {analyticsError ? <p className="error-text">{analyticsError}</p> : null}

          <div className="metrics-grid">
            <section className="metric-card">
              <span className="metric-label">Created</span>
              <strong className="metric-value">{analytics?.totals.createdInWindow ?? 0}</strong>
            </section>
            <section className="metric-card">
              <span className="metric-label">Completed</span>
              <strong className="metric-value">{analytics?.totals.completedInWindow ?? 0}</strong>
            </section>
            <section className="metric-card">
              <span className="metric-label">Open now</span>
              <strong className="metric-value">{analytics?.totals.openNow ?? 0}</strong>
            </section>
            <section className="metric-card">
              <span className="metric-label">Overdue open</span>
              <strong className="metric-value">{analytics?.totals.overdueOpen ?? 0}</strong>
            </section>
            <section className="metric-card">
              <span className="metric-label">Completion rate</span>
              <strong className="metric-value">{Math.round((analytics?.totals.completionRateInWindow ?? 0) * 100)}%</strong>
            </section>
          </div>

          <section className="analytics-card">
            <header className="section-head analytics-head">
              <h2>Daily throughput</h2>
              <div className="analytics-legend">
                <span className="legend-item">
                  <span className="legend-swatch legend-created" /> Created
                </span>
                <span className="legend-item">
                  <span className="legend-swatch legend-completed" /> Completed
                </span>
              </div>
            </header>
            <div className="chart-grid" role="img" aria-label="Daily created and completed todos">
              {dailyMetrics.map((point) => {
                const createdHeight = `${Math.round((point.created / maxDailyMetric) * 100)}%`;
                const completedHeight = `${Math.round((point.completed / maxDailyMetric) * 100)}%`;
                return (
                  <div className="chart-day" key={point.date}>
                    <div className="chart-bars">
                      <span
                        className="chart-bar chart-bar-created"
                        style={{ height: createdHeight }}
                        title={`${dayLabel(point.date)}: ${point.created} created`}
                      />
                      <span
                        className="chart-bar chart-bar-completed"
                        style={{ height: completedHeight }}
                        title={`${dayLabel(point.date)}: ${point.completed} completed`}
                      />
                    </div>
                    <span className="chart-label">{dayLabel(point.date)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="breakdown-grid">
            <section className="analytics-card">
              <h2>By owner</h2>
              <ul className="breakdown-list">
                {analyticsOwnerBreakdown.map((entry) => (
                  <li key={entry.owner}>
                    <span>{entry.owner}</span>
                    <span>
                      open {entry.openNow} | +{entry.createdInWindow} / -{entry.completedInWindow}
                    </span>
                  </li>
                ))}
                {analyticsOwnerBreakdown.length === 0 ? <li>No owner data.</li> : null}
              </ul>
            </section>

            <section className="analytics-card">
              <h2>By project</h2>
              <ul className="breakdown-list">
                {analyticsProjectBreakdown.map((entry) => (
                  <li key={entry.projectTag}>
                    <span>{entry.projectTag}</span>
                    <span>
                      open {entry.openNow} | +{entry.createdInWindow} / -{entry.completedInWindow}
                    </span>
                  </li>
                ))}
                {analyticsProjectBreakdown.length === 0 ? <li>No project data.</li> : null}
              </ul>
            </section>
          </div>
        </section>
      ) : (
        <section className="card">
          <h2>
            <UserCircle size={18} weight="fill" /> User token
          </h2>
          <SensitiveInput label="Bearer token" value={token ?? ""} readOnly />
          {token ? <ClipboardText text={token} tooltip={{ text: "Copy token", copiedText: "Token copied" }} /> : null}
        </section>
      )}
    </main>
  );
}
