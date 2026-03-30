import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  ChartBar,
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  ClipboardText,
  Moon,
  Robot,
  SignOut,
  Sun,
  Tag,
  Trash,
  User,
  UserCircle
} from "@phosphor-icons/react";

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
      timeZone: string;
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

const pathForPage = (page: Page): string => {
  if (page === "analytics") {
    return "/analytics";
  }
  if (page === "user") {
    return "/user";
  }
  return "/";
};

const pageForPath = (pathname: string): Page => {
  if (pathname === "/analytics") {
    return "analytics";
  }
  if (pathname === "/user") {
    return "user";
  }
  return "tasks";
};

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
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

const isWeekendDay = (isoDay: string): boolean => {
  const parsed = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  const day = parsed.getUTCDay();
  return day === 0 || day === 6;
};

const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function App() {
  const initialPage = typeof window === "undefined" ? "tasks" : pageForPath(window.location.pathname);
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
  const [activePage, setActivePage] = useState<Page>(initialPage);
  const [token, setToken] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsResponse["analytics"] | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [copiedToken, setCopiedToken] = useState(false);

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
    const [openResponse, doneResponse] = await Promise.all([
      fetch("/ui/api/tasks?status=open&limit=500", { method: "GET" }),
      fetch("/ui/api/tasks?status=done&limit=500", { method: "GET" })
    ]);
    if (!openResponse.ok) {
      setTaskError(await readError(openResponse));
      setLoadingTasks(false);
      return;
    }
    if (!doneResponse.ok) {
      setTaskError(await readError(doneResponse));
      setLoadingTasks(false);
      return;
    }

    const [openPayload, donePayload] = (await Promise.all([
      openResponse.json(),
      doneResponse.json()
    ])) as [TasksResponse, TasksResponse];

    setTasks([...openPayload.tasks, ...donePayload.tasks]);
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
    const timeZone = browserTimeZone();
    const response = await fetch(
      `/ui/api/analytics/overview?days=${analyticsDays}&timeZone=${encodeURIComponent(timeZone)}`,
      { method: "GET" }
    );
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
    const savedTheme = window.localStorage.getItem("tiny-todo-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("tiny-todo-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onPopState = (): void => {
      setActivePage(pageForPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
    setCopiedToken(false);
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

  const copyToken = async (): Promise<void> => {
    if (!token) {
      return;
    }
    await navigator.clipboard.writeText(token);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 1200);
  };

  const navigateToPage = (page: Page): void => {
    setActivePage(page);
    const nextPath = pathForPage(page);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ page }, "", nextPath);
    }
  };

  const renderTaskRow = (task: Task) => {
    const owner = ownerOfTask(task);
    const ownerTitle = owner === "agent" ? "Agent-owned" : owner === "user" ? "User-owned" : "Unknown owner";
    return (
      <li className="task-item" key={task.id}>
        <span className="owner-icon" title={ownerTitle}>
          {owner === "agent" ? <Robot size={14} weight="fill" /> : <User size={14} weight="fill" />}
        </span>
        <input
          className="text-input"
          defaultValue={task.title}
          disabled={task.status === "done"}
          onBlur={(event: ChangeEvent<HTMLInputElement>) => void updateTaskTitle(task, event.currentTarget.value)}
        />
        <span className="task-meta">{task.dueDate ?? "No due date"}</span>
        <div className="task-item-actions">
          {task.status === "open" ? (
            <button className="btn" onClick={() => void completeTask(task.id)}>
              <CheckCircle size={14} weight="bold" />
              Complete
            </button>
          ) : null}
          <button className="btn btn-danger" onClick={() => void deleteTask(task.id)}>
            <Trash size={14} weight="bold" />
            Delete
          </button>
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
        <section className="panel auth-panel">
          <h1 className="title">Tiny Todo Web</h1>
          <div className="auth-form">
            <input
              className="text-input"
              type="password"
              value={password}
              placeholder="UI password"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void login();
                }
              }}
            />
            <button className="btn" onClick={() => void login()}>
              Unlock
            </button>
          </div>
          {passwordError ? <p className="error-text">{passwordError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="app-layout">
        <aside className="page-nav" aria-label="Pages">
          <button className={`page-button${activePage === "tasks" ? " is-active" : ""}`} onClick={() => navigateToPage("tasks")}>
            Tasks
          </button>
          <button
            className={`page-button${activePage === "analytics" ? " is-active" : ""}`}
            onClick={() => navigateToPage("analytics")}
          >
            Analytics
          </button>
          <button className={`page-button${activePage === "user" ? " is-active" : ""}`} onClick={() => navigateToPage("user")}>
            User
          </button>
        </aside>

        <section className="page-content">
          {activePage === "tasks" ? (
            <section className="panel tasks-page">
              <header className="section-head">
                <h1 className="title">Operations</h1>
                <div className="stats-inline">
                  <span>
                    <Circle size={10} weight="fill" /> {openTasks.length} open
                  </span>
                  <span>
                    <CheckCircle size={10} weight="fill" /> {doneTasks.length} closed
                  </span>
                </div>
              </header>

              <section className="task-create-grid" aria-label="Create task">
                <input
                  className="text-input"
                  placeholder="Task title"
                  value={taskTitle}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTitle(event.currentTarget.value)}
                />
                <input
                  className="text-input"
                  placeholder="Task note"
                  value={taskNote}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskNote(event.currentTarget.value)}
                />
                <input
                  className="text-input"
                  placeholder="tags (comma separated)"
                  value={taskTags}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTags(event.currentTarget.value)}
                />
                <input
                  className="text-input"
                  type="date"
                  value={taskDueDate}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskDueDate(event.currentTarget.value)}
                />
                <button className="btn btn-primary" onClick={() => void createTask()}>
                  Add task
                </button>
              </section>

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
                        <Tag size={12} weight="bold" />
                        {group.tag}
                      </span>
                      <span className="count-badge">{group.tasks.length}</span>
                    </header>
                    <ul className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</ul>
                  </section>
                ))}
                {openGroups.length === 0 ? <p className="task-meta">No open tasks.</p> : null}
              </div>

              <div className="section-head">
                <h2>Closed</h2>
                <button className="btn" onClick={() => setShowClosed((value) => !value)}>
                  {showClosed ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
                  {showClosed ? "Hide" : "Show"} closed ({doneTasks.length})
                </button>
              </div>

              {showClosed ? (
                <div className="tag-grid">
                  {doneGroups.map((group) => (
                    <section className="tag-group tag-group-closed" key={`done-${group.tag}`}>
                      <header className="tag-head">
                        <span className="tag-label">
                          <Tag size={12} weight="bold" />
                          {group.tag}
                        </span>
                        <span className="count-badge">{group.tasks.length}</span>
                      </header>
                      <ul className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</ul>
                    </section>
                  ))}
                  {doneGroups.length === 0 ? <p className="task-meta">No closed tasks.</p> : null}
                </div>
              ) : null}
            </section>
          ) : activePage === "analytics" ? (
            <section className="panel analytics-page">
              <header className="section-head analytics-head">
                <h1 className="title">
                  <ChartBar size={16} weight="fill" /> Analytics ({analyticsDays} days)
                </h1>
                {loadingAnalytics ? <span className="task-meta">Loading...</span> : null}
              </header>
              {analytics ? (
                <p className="task-meta panel-line">
                  Window: {analytics.window.startDate} to {analytics.window.endDate} ({analytics.window.timeZone})
                </p>
              ) : null}
              {analyticsError ? <p className="error-text panel-line">{analyticsError}</p> : null}

              <div className="metrics-grid">
                <section className="metric-box">
                  <span className="metric-label">Created</span>
                  <strong className="metric-value">{analytics?.totals.createdInWindow ?? 0}</strong>
                </section>
                <section className="metric-box">
                  <span className="metric-label">Completed</span>
                  <strong className="metric-value">{analytics?.totals.completedInWindow ?? 0}</strong>
                </section>
                <section className="metric-box">
                  <span className="metric-label">Open now</span>
                  <strong className="metric-value">{analytics?.totals.openNow ?? 0}</strong>
                </section>
                <section className="metric-box">
                  <span className="metric-label">Overdue open</span>
                  <strong className="metric-value">{analytics?.totals.overdueOpen ?? 0}</strong>
                </section>
                <section className="metric-box">
                  <span className="metric-label">Completion rate</span>
                  <strong className="metric-value">{Math.round((analytics?.totals.completionRateInWindow ?? 0) * 100)}%</strong>
                </section>
              </div>

              <section className="panel-subsection">
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
                    const createdRatio = point.created / maxDailyMetric;
                    const completedRatio = point.completed / maxDailyMetric;
                    const createdHeight = `${Math.round(createdRatio * 100)}%`;
                    const completedHeight = `${Math.round(completedRatio * 100)}%`;
                    const createdSignalOpacity = Math.max(0.2, createdRatio);
                    const completedSignalOpacity = Math.max(0.2, completedRatio);
                    const weekendClass = isWeekendDay(point.date) ? " chart-day-weekend" : "";
                    return (
                      <div className={`chart-day${weekendClass}`} key={point.date}>
                        <div className="chart-signal" aria-hidden>
                          <span
                            className="chart-signal-chip chart-signal-created"
                            style={{ opacity: createdSignalOpacity }}
                          />
                          <span
                            className="chart-signal-chip chart-signal-completed"
                            style={{ opacity: completedSignalOpacity }}
                          />
                        </div>
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
                <section className="panel-subsection">
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

                <section className="panel-subsection">
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
            <section className="panel user-page">
              <h1 className="title">
                <UserCircle size={16} weight="fill" /> User token
              </h1>
              <label className="token-label panel-line" htmlFor="token-field">
                Bearer token
              </label>
              <input id="token-field" className="text-input panel-line" value={token ?? ""} readOnly />
              <div className="token-actions">
                <button className="btn" onClick={() => void copyToken()} disabled={!token}>
                  <ClipboardText size={14} weight="bold" />
                  {copiedToken ? "Copied" : "Copy token"}
                </button>
              </div>
            </section>
          )}
        </section>
      </div>

      <section className="dock" aria-label="Control dock">
        <button className="dock-action" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}> 
          {theme === "dark" ? <Sun size={14} weight="bold" /> : <Moon size={14} weight="bold" />}
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <span className="dock-divider" aria-hidden="true" />
        <button className="dock-action" onClick={() => void logout()}>
          <SignOut size={14} weight="bold" />
          Exit
        </button>
      </section>
    </main>
  );
}
