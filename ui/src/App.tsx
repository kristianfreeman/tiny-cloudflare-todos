import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ClickableRow, Container, Panel, Row, RowStack, SubtlePanel, type RowAction } from "shiro";

interface Task {
  id: string;
  title: string;
  note: string | null;
  tags: string[];
  dueDate: string | null;
  recurrenceRuleId: string | null;
  status: "open" | "done";
  createdAt: string;
  completedAt: string | null;
}

interface RecurrenceRule {
  id: string;
  listId: string;
  titleTemplate: string;
  noteTemplate: string | null;
  cadence: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays: number[] | null;
  dayOfMonth: number | null;
  timezone: string;
  anchorDate: string;
  nextRunDate: string;
  exceptionDates: string[] | null;
  generationPolicy: "calendar" | "completion";
  tags: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TasksResponse {
  tasks: Task[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface RecurrenceRulesResponse {
  recurrenceRules: RecurrenceRule[];
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

interface ChangesResponse {
  changes: {
    checkedAt: string;
    cursor: string | null;
    hasChanges: boolean;
  };
}

type Page = "new-task" | "recurring" | "tasks" | "analytics" | "settings";

type AnalyticsWindowDays = 1 | 7 | 30;

const pathForPage = (page: Page): string => {
  if (page === "new-task") {
    return "/new";
  }
  if (page === "recurring") {
    return "/recurring";
  }
  if (page === "analytics") {
    return "/analytics";
  }
  if (page === "settings") {
    return "/settings";
  }
  return "/";
};

const pageForPath = (pathname: string): Page => {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPath === "/new") {
    return "new-task";
  }
  if (normalizedPath === "/recurring") {
    return "recurring";
  }
  if (normalizedPath === "/analytics") {
    return "analytics";
  }
  if (normalizedPath === "/settings" || normalizedPath === "/user") {
    return "settings";
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
  const weekday = parsed.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${isoDay}`;
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

const ACTIVE_POLL_INTERVAL_MS = 10_000;
const IDLE_POLL_INTERVAL_MS = 120_000;
const ACTIVE_INTERACTION_WINDOW_MS = 20_000;
const CLOSED_PAGE_SIZE = 100;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const isoTodayLocal = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dueDateTone = (dueDate: string | null): "danger" | "alert" | null => {
  if (!dueDate) {
    return null;
  }
  const today = new Date(`${isoTodayLocal()}T00:00:00Z`);
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(today.getTime()) || Number.isNaN(due.getTime())) {
    return null;
  }
  const dayDelta = Math.floor((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (dayDelta <= 0) {
    return "danger";
  }
  if (dayDelta <= 3) {
    return "alert";
  }
  return null;
};

export function App() {
  const initialPage = typeof window === "undefined" ? "tasks" : pageForPath(window.location.pathname);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<Task[]>([]);
  const [closedTasks, setClosedTasks] = useState<Task[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNote, setTaskNote] = useState("");
  const [taskTags, setTaskTags] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [recurrenceRules, setRecurrenceRules] = useState<RecurrenceRule[]>([]);
  const [recurrenceTitle, setRecurrenceTitle] = useState("");
  const [recurrenceCadence, setRecurrenceCadence] = useState<"daily" | "weekly" | "monthly">("daily");
  const [recurrencePolicy, setRecurrencePolicy] = useState<"calendar" | "completion">("completion");
  const [recurrenceInterval, setRecurrenceInterval] = useState("1");
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState("");
  const [recurrenceDayOfMonth, setRecurrenceDayOfMonth] = useState("");
  const [recurrenceTimezone, setRecurrenceTimezone] = useState(browserTimeZone());
  const [recurrenceSkipDates, setRecurrenceSkipDates] = useState("");
  const [recurrenceTags, setRecurrenceTags] = useState("owner:user,project:general");
  const [recurrenceAdvanced, setRecurrenceAdvanced] = useState(false);
  const [showPausedRecurrence, setShowPausedRecurrence] = useState(false);
  const [recurrenceError, setRecurrenceError] = useState<string | null>(null);
  const [loadingRecurrenceRules, setLoadingRecurrenceRules] = useState(false);
  const [activePage, setActivePage] = useState<Page>(initialPage);
  const [token, setToken] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingClosedTasks, setLoadingClosedTasks] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [closedLoaded, setClosedLoaded] = useState(false);
  const [closedTotalCount, setClosedTotalCount] = useState(0);
  const [closedHasMore, setClosedHasMore] = useState(false);
  const [analyticsDays, setAnalyticsDays] = useState<AnalyticsWindowDays>(30);
  const [analytics, setAnalytics] = useState<AnalyticsResponse["analytics"] | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [copiedToken, setCopiedToken] = useState(false);
  const [idRevealActive, setIdRevealActive] = useState(false);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const lastInteractionAtRef = useRef<number>(Date.now());
  const changesCursorRef = useRef<string | null>(null);
  const copiedTaskIdTimerRef = useRef<number | null>(null);

  const openGroups = useMemo(() => groupTasksByTag(openTasks), [openTasks]);
  const doneGroups = useMemo(() => groupTasksByTag(closedTasks), [closedTasks]);
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

  const loadOpenTasks = async (options?: { silent?: boolean }): Promise<void> => {
    if (!options?.silent) {
      setLoadingTasks(true);
    }
    const openResponse = await fetch("/ui/api/tasks?status=open&limit=500", { method: "GET" });
    if (!openResponse.ok) {
      setTaskError(await readError(openResponse));
      if (!options?.silent) {
        setLoadingTasks(false);
      }
      return;
    }
    const openPayload = (await openResponse.json()) as TasksResponse;

    setOpenTasks(openPayload.tasks);
    setTaskError(null);
    if (!options?.silent) {
      setLoadingTasks(false);
    }
  };

  const loadRecurrenceRules = async (options?: { silent?: boolean }): Promise<void> => {
    if (!options?.silent) {
      setLoadingRecurrenceRules(true);
    }
    const response = await fetch("/ui/api/recurrence-rules?active=all", { method: "GET" });
    if (!response.ok) {
      setRecurrenceError(await readError(response));
      if (!options?.silent) {
        setLoadingRecurrenceRules(false);
      }
      return;
    }

    const payload = (await response.json()) as RecurrenceRulesResponse;
    setRecurrenceRules(payload.recurrenceRules);
    setRecurrenceError(null);
    if (!options?.silent) {
      setLoadingRecurrenceRules(false);
    }
  };

  const loadClosedTasks = async (options?: { silent?: boolean; offset?: number; append?: boolean }): Promise<void> => {
    const offset = options?.offset ?? 0;
    if (!options?.silent) {
      setLoadingClosedTasks(true);
    }
    const response = await fetch(
      `/ui/api/tasks?status=done&sort=completed_at_desc&limit=${CLOSED_PAGE_SIZE}&offset=${offset}`,
      { method: "GET" }
    );
    if (!response.ok) {
      setTaskError(await readError(response));
      if (!options?.silent) {
        setLoadingClosedTasks(false);
      }
      return;
    }

    const payload = (await response.json()) as TasksResponse;
    setClosedTasks((previous) => (options?.append ? [...previous, ...payload.tasks] : payload.tasks));
    setClosedTotalCount(payload.total);
    setClosedHasMore(payload.hasMore);
    setClosedLoaded(true);
    setTaskError(null);
    if (!options?.silent) {
      setLoadingClosedTasks(false);
    }
  };

  const loadMoreClosedTasks = async (): Promise<void> => {
    if (loadingClosedTasks || !closedHasMore) {
      return;
    }
    await loadClosedTasks({ offset: closedTasks.length, append: true });
  };

  const loadMe = async (): Promise<void> => {
    const response = await fetch("/ui/me", { method: "GET" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { token: string | null };
    setToken(payload.token);
  };

  const loadAnalytics = async (options?: { silent?: boolean }): Promise<void> => {
    if (!options?.silent) {
      setLoadingAnalytics(true);
    }
    const timeZone = browserTimeZone();
    const response = await fetch(
      `/ui/api/analytics/overview?days=${analyticsDays}&timeZone=${encodeURIComponent(timeZone)}`,
      { method: "GET" }
    );
    if (!response.ok) {
      setAnalyticsError(await readError(response));
      if (!options?.silent) {
        setLoadingAnalytics(false);
      }
      return;
    }
    const payload = (await response.json()) as AnalyticsResponse;
    setAnalytics(payload.analytics);
    setAnalyticsError(null);
    if (!options?.silent) {
      setLoadingAnalytics(false);
    }
  };

  const hasFocusedEditable = (): boolean => {
    const activeElement = document.activeElement;
    if (!activeElement) {
      return false;
    }
    const tagName = activeElement.tagName.toLowerCase();
    return (
      activeElement instanceof HTMLElement &&
      (activeElement.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select")
    );
  };

  const refreshVisibleData = async (): Promise<void> => {
    await Promise.all([
      loadOpenTasks({ silent: true }),
      loadRecurrenceRules({ silent: true }),
      loadAnalytics({ silent: true }),
      showClosed ? loadClosedTasks({ silent: true }) : Promise.resolve()
    ]);
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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Shift" && !hasFocusedEditable()) {
        setIdRevealActive(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Shift") {
        setIdRevealActive(false);
      }
    };
    const clearReveal = (): void => setIdRevealActive(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearReveal);
    document.addEventListener("visibilitychange", clearReveal);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearReveal);
      document.removeEventListener("visibilitychange", clearReveal);
    };
  }, []);

  useEffect(
    () => () => {
      if (copiedTaskIdTimerRef.current !== null) {
        window.clearTimeout(copiedTaskIdTimerRef.current);
      }
    },
    []
  );

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
    void loadOpenTasks();
    void loadRecurrenceRules();
    void loadMe();
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void loadAnalytics();
  }, [authenticated, analyticsDays]);

  useEffect(() => {
    if (!authenticated || !showClosed || closedLoaded) {
      return;
    }
    void loadClosedTasks();
  }, [authenticated, showClosed, closedLoaded]);

  useEffect(() => {
    if (!authenticated) {
      changesCursorRef.current = null;
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const markInteraction = (): void => {
      lastInteractionAtRef.current = Date.now();
    };

    const activityEvents: Array<keyof WindowEventMap> = ["mousemove", "keydown", "pointerdown", "scroll", "focus"];
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markInteraction, { passive: true });
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        markInteraction();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const nextPollDelay = (): number => {
      const isVisible = document.visibilityState === "visible";
      const interactedRecently = Date.now() - lastInteractionAtRef.current <= ACTIVE_INTERACTION_WINDOW_MS;
      return isVisible && interactedRecently ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    };

    const pollChanges = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      try {
        const params = new URLSearchParams();
        if (changesCursorRef.current) {
          params.set("since", changesCursorRef.current);
        }
        const query = params.toString();
        const response = await fetch(`/ui/api/changes${query ? `?${query}` : ""}`, { method: "GET" });
        if (response.ok) {
          const payload = (await response.json()) as ChangesResponse;
          if (payload.changes.cursor) {
            changesCursorRef.current = payload.changes.cursor;
          }
          if (payload.changes.hasChanges && !hasFocusedEditable()) {
            await refreshVisibleData();
          }
        }
      } catch {
        // best-effort background refresh
      }

      if (!cancelled) {
        pollTimer = setTimeout(() => {
          void pollChanges();
        }, nextPollDelay());
      }
    };

    void pollChanges();

    return () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markInteraction);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authenticated, showClosed, analyticsDays]);

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
    setOpenTasks([]);
    setClosedTasks([]);
    setClosedLoaded(false);
    setClosedTotalCount(0);
    setClosedHasMore(false);
    setAnalytics(null);
    setRecurrenceRules([]);
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
    await Promise.all([loadOpenTasks(), loadAnalytics()]);
    if (showClosed) {
      await loadClosedTasks();
    }
  };

  const createRecurrenceRule = async (): Promise<void> => {
    const titleTemplate = recurrenceTitle.trim();
    if (!titleTemplate) {
      setRecurrenceError("Recurring title is required.");
      return;
    }

    const intervalRaw = Number(recurrenceInterval);
    if (!Number.isInteger(intervalRaw) || intervalRaw < 1) {
      setRecurrenceError("Interval must be a positive integer.");
      return;
    }

    const payload: Record<string, unknown> = {
      titleTemplate,
      cadence: recurrenceCadence,
      interval: intervalRaw,
      generationPolicy: recurrencePolicy,
      timezone: recurrenceTimezone.trim() || browserTimeZone()
    };

    const recurrenceTagValues = recurrenceTags
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    if (recurrenceTagValues.length > 0) {
      payload.tags = recurrenceTagValues;
    }

    if (recurrenceCadence === "weekly") {
      const weekdays = recurrenceWeekdays
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
      if (weekdays.length > 0) {
        payload.weekdays = weekdays;
      }
    }

    if (recurrenceCadence === "monthly") {
      const dayRaw = recurrenceDayOfMonth.trim();
      if (dayRaw.length > 0) {
        const day = Number(dayRaw);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          setRecurrenceError("Day of month must be an integer between 1 and 31.");
          return;
        }
        payload.dayOfMonth = day;
      }
    }

    const exceptionDates = recurrenceSkipDates
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (exceptionDates.length > 0) {
      payload.exceptionDates = exceptionDates;
    }

    const response = await fetch("/ui/api/recurrence-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      setRecurrenceError(await readError(response));
      return;
    }

    setRecurrenceTitle("");
    setRecurrenceInterval("1");
    setRecurrenceWeekdays("");
    setRecurrenceDayOfMonth("");
    setRecurrenceSkipDates("");
    setRecurrencePolicy("completion");
    setRecurrenceError(null);
    await Promise.all([loadRecurrenceRules(), loadOpenTasks()]);
  };

  const toggleRecurrenceRule = async (rule: RecurrenceRule): Promise<void> => {
    const response = await fetch(`/ui/api/recurrence-rules/${encodeURIComponent(rule.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !rule.active })
    });
    if (!response.ok) {
      setRecurrenceError(await readError(response));
      return;
    }
    await loadRecurrenceRules();
  };

  const completeTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}/complete`, { method: "POST" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await Promise.all([loadOpenTasks(), loadAnalytics()]);
    if (showClosed) {
      await loadClosedTasks();
    }
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
    await Promise.all([loadOpenTasks(), loadAnalytics()]);
    if (showClosed) {
      await loadClosedTasks();
    }
  };

  const deleteTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await loadOpenTasks();
    if (showClosed) {
      await loadClosedTasks();
    }
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

  const copyTaskId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedTaskId(id);
      if (copiedTaskIdTimerRef.current !== null) {
        window.clearTimeout(copiedTaskIdTimerRef.current);
      }
      copiedTaskIdTimerRef.current = window.setTimeout(() => {
        setCopiedTaskId(null);
      }, 1200);
    } catch {
      setTaskError("Could not copy task ID. Check clipboard permissions.");
    }
  };

  const navigateToPage = (page: Page): void => {
    setActivePage(page);
    const nextPath = pathForPage(page);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ page }, "", nextPath);
    }
  };

  const recurrenceSummary = (rule: RecurrenceRule): string => {
    const every = `every ${rule.interval} ${rule.cadence}${rule.interval === 1 ? "" : "s"}`;
    if (rule.cadence === "weekly" && rule.weekdays && rule.weekdays.length > 0) {
      const labels = rule.weekdays.map((day) => WEEKDAY_LABELS[day] ?? String(day)).join(",");
      return `${every} on ${labels}`;
    }
    if (rule.cadence === "monthly" && rule.dayOfMonth) {
      return `${every} on day ${rule.dayOfMonth}`;
    }
    return every;
  };

  const visibleRecurrenceRules = recurrenceRules.filter((rule) => rule.active || showPausedRecurrence);
  const pausedRecurrenceCount = recurrenceRules.filter((rule) => !rule.active).length;

  const renderTaskRow = (task: Task) => {
    const owner = ownerOfTask(task);
    const ownerLabel = owner === "agent" ? "agent" : "user";
    const dueTone = dueDateTone(task.dueDate);
    const taskActions: RowAction[] = [];
    if (task.recurrenceRuleId) {
      taskActions.push({
        icon: "↻",
        callbackFunc: () => navigateToPage("recurring"),
        title: "Open recurring rules",
        ariaLabel: "Open recurring rules",
      });
    }
    if (task.status === "open") {
      taskActions.push({
        icon: "✓",
        callbackFunc: () => {
          if (window.confirm("Mark this task complete?")) {
            void completeTask(task.id);
          }
        },
        title: "Complete task",
        ariaLabel: "Complete task",
      });
    }
    taskActions.push({
      icon: "🗑",
      callbackFunc: () => {
        if (window.confirm("Delete this task permanently?")) {
          void deleteTask(task.id);
        }
      },
      title: "Delete task",
      ariaLabel: "Delete task",
      tone: "danger",
    });

    return (
      <Row
        key={task.id}
        className="task-item"
        tone="transparent"
        density="compact"
        hideSlotsSm={["secondary"]}
        hideSlotsMd={["secondary"]}
        primary={
          <>
            {idRevealActive ? (
              <button className="task-id-copy" type="button" onClick={() => void copyTaskId(task.id)} title={`Copy ${task.id}`}>
                {task.id}
              </button>
            ) : (
              <input
                className="text-input"
                defaultValue={task.title}
                disabled={task.status === "done"}
                onBlur={(event: ChangeEvent<HTMLInputElement>) => void updateTaskTitle(task, event.currentTarget.value)}
              />
            )}
            <em className="task-owner-label">{ownerLabel}</em>
          </>
        }
        warningText={task.dueDate ? <span className={`task-meta${dueTone ? ` task-meta-${dueTone}` : ""}`}>{task.dueDate}</span> : undefined}
        actions={taskActions}
      />
    );
  };

  if (!sessionChecked) {
    return (
      <Container as="main" className="app-shell app-auth-shell">
        <Panel className="auth-panel">
          <Row className="status-row" primary={<span className="task-meta">Checking session...</span>} />
        </Panel>
      </Container>
    );
  }

  if (!authenticated) {
    return (
      <Container as="main" className="app-shell app-auth-shell">
        <Panel className="auth-panel">
          <Row className="auth-row" primary={<span className="title">Tiny Todo Web</span>} />
          <Row
            className="auth-row"
            primary={
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
            }
            actions={[{ icon: "Unlock", callbackFunc: () => void login() }]}
          />
          {passwordError ? <Row className="auth-row" primary={<span className="error-text">{passwordError}</span>} /> : null}
        </Panel>
      </Container>
    );
  }

  return (
    <Container as="main" className="app-shell">
      <Container className="app-layout">
        <Container as="aside" className="page-nav" aria-label="Pages">
          <ClickableRow active={activePage === "new-task"} onClick={() => navigateToPage("new-task")}>
            New task
          </ClickableRow>
          <ClickableRow active={activePage === "tasks"} onClick={() => navigateToPage("tasks")}>
            Tasks
          </ClickableRow>
          <ClickableRow className="nav-recurring" active={activePage === "recurring"} onClick={() => navigateToPage("recurring")}>
            Recurring
          </ClickableRow>
          <ClickableRow active={activePage === "analytics"} onClick={() => navigateToPage("analytics")}>
            Analytics
          </ClickableRow>
          <ClickableRow active={activePage === "settings"} onClick={() => navigateToPage("settings")}>
            Settings
          </ClickableRow>
        </Container>

        <Container as="section" className="page-content">
          {activePage === "tasks" || activePage === "new-task" || activePage === "recurring" ? (
            <Panel className="tasks-page">
              <Row
                className="section-head-row"
                style="title"
                as="h1"
                primary={<span className="title">{activePage === "new-task" ? "New Task" : activePage === "recurring" ? "Recurring" : "Tasks"}</span>}
                hideSlotsSm={activePage === "tasks" ? ["secondary"] : undefined}
                hideSlotsMd={activePage === "tasks" ? ["secondary"] : undefined}
                secondaryText={
                  activePage === "tasks" ? (
                    <span className="task-meta">
                      {openTasks.length} open / {closedLoaded ? `${closedTotalCount} closed` : "closed not loaded"}
                    </span>
                  ) : undefined
                }
              />

              {activePage === "new-task" ? (
              <SubtlePanel as="section" className="row-form" aria-label="Create task">
                <RowStack>
                  <Row
                    className="row-form-item"
                    primary={
                      <>
                        <span className="row-label">Title</span>
                        <input
                          className="text-input"
                          placeholder="Task title"
                          value={taskTitle}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTitle(event.currentTarget.value)}
                        />
                      </>
                    }
                  />
                  <Row
                    className="row-form-item"
                    primary={
                      <>
                        <span className="row-label">Note</span>
                        <input
                          className="text-input"
                          placeholder="Task note"
                          value={taskNote}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskNote(event.currentTarget.value)}
                        />
                      </>
                    }
                  />
                  <Row
                    className="row-form-item"
                    primary={
                      <>
                        <span className="row-label">Tags</span>
                        <input
                          className="text-input"
                          placeholder="owner:user,project:..."
                          value={taskTags}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskTags(event.currentTarget.value)}
                        />
                      </>
                    }
                  />
                  <Row
                    className="row-form-item"
                    primary={
                      <>
                        <span className="row-label">Due</span>
                        <input
                          className="text-input"
                          type="date"
                          value={taskDueDate}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskDueDate(event.currentTarget.value)}
                        />
                      </>
                    }
                  />
                  <Row
                    className="row-form-item row-form-submit"
                    primary={<span className="task-meta">Create a new task with optional note, tags, and due date.</span>}
                    actions={[{ icon: "Add task", callbackFunc: () => void createTask() }]}
                  />
                </RowStack>
              </SubtlePanel>
              ) : null}

              {activePage === "recurring" ? (
              <>
              <Row className="section-head-row" style="title" as="h2" primary={<span className="title">Create a new recurrence</span>} />
              <Row
                className="status-row"
                style="warning"
                primary={<span>Not supported in the web UI yet. Please use the CLI for recurrence creation.</span>}
              />

              <Row
                className="section-head-row"
                style="title"
                as="h2"
                primary={<span className="title">Active recurrences</span>}
                alertText={loadingRecurrenceRules ? <span className="task-meta">Loading...</span> : undefined}
                actions={
                  pausedRecurrenceCount > 0
                    ? [
                        {
                          icon: showPausedRecurrence ? "Hide paused" : `Show paused (${pausedRecurrenceCount})`,
                          callbackFunc: () => setShowPausedRecurrence((value) => !value),
                        },
                      ]
                    : undefined
                }
              />

              {recurrenceError ? <Row className="status-row" primary={<span className="error-text">{recurrenceError}</span>} /> : null}

              <RowStack className="tag-grid recurrence-rule-grid">
                {visibleRecurrenceRules.map((rule) => (
                  <SubtlePanel className="tag-group" key={rule.id}>
                    <Row
                      className="tag-head-row"
                      style="group-header"
                      as="h3"
                      primary={<span className="tag-label">{rule.titleTemplate}</span>}
                      actions={[{ icon: rule.active ? "Pause" : "Resume", callbackFunc: () => void toggleRecurrenceRule(rule) }]}
                    />
                    <Row
                      className="rule-detail-row"
                      primary={
                        <span className="task-meta">
                          {recurrenceSummary(rule)} | {rule.generationPolicy} | next {rule.nextRunDate} | {rule.timezone} | {rule.active ? "active" : "paused"}
                        </span>
                      }
                    />
                    <Row className="rule-detail-row" primary={<span className="task-meta">tags: {rule.tags.join(",")}</span>} />
                    {rule.exceptionDates && rule.exceptionDates.length > 0 ? (
                      <Row className="rule-detail-row" primary={<span className="task-meta">skip: {rule.exceptionDates.join(",")}</span>} />
                    ) : null}
                  </SubtlePanel>
                ))}
                {visibleRecurrenceRules.length === 0 ? <Row className="status-row" primary={<span className="task-meta">No recurrence rules.</span>} /> : null}
              </RowStack>
              </>
              ) : null}

              {activePage === "tasks" ? (
              <>
              <Row
                className="section-head-row"
                style="title"
                as="h2"
                hideSlotsSm={["warning"]}
                hideSlotsMd={["warning"]}
                primary={<span className="title">Open</span>}
                warningText={<span className="task-meta">Hold Shift to reveal IDs and click to copy.</span>}
                alertText={copiedTaskId ? <span className="task-meta task-meta-success">Copied {copiedTaskId}</span> : loadingTasks ? <span className="task-meta">Loading...</span> : undefined}
              />
              {taskError ? <Row className="status-row" primary={<span className="error-text">{taskError}</span>} /> : null}

              <RowStack className="tag-grid">
                {openGroups.map((group) => (
                  <SubtlePanel className="tag-group" key={`open-${group.tag}`}>
                    <Row className="tag-head-row" style="group-header" as="h3" primary={<span className="tag-label">{group.tag} ({group.tasks.length})</span>} />
                    <RowStack className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</RowStack>
                  </SubtlePanel>
                ))}
                {openGroups.length === 0 ? <Row className="status-row" primary={<span className="task-meta">No open tasks.</span>} /> : null}
              </RowStack>

              <Row
                className="section-head-row"
                style="title"
                as="h2"
                primary={<span className="title">Closed</span>}
                warningText={<span className="task-meta">{closedLoaded ? `${closedTotalCount} total` : "closed"}</span>}
                actions={[{ icon: showClosed ? "Hide" : "Show", callbackFunc: () => setShowClosed((value) => !value) }]}
              />

              {showClosed ? (
                <RowStack className="tag-grid">
                  {loadingClosedTasks ? <Row className="status-row" primary={<span className="task-meta">Loading closed tasks...</span>} /> : null}
                  {closedLoaded ? <Row className="status-row" primary={<span className="task-meta">Showing {closedTasks.length} of {closedTotalCount} closed tasks.</span>} /> : null}
                  {doneGroups.map((group) => (
                    <SubtlePanel className="tag-group tag-group-closed" key={`done-${group.tag}`}>
                      <Row className="tag-head-row" style="group-header" as="h3" primary={<span className="tag-label">{group.tag} ({group.tasks.length})</span>} />
                      <RowStack className="task-list">{group.tasks.map((task) => renderTaskRow(task))}</RowStack>
                    </SubtlePanel>
                  ))}
                  {doneGroups.length === 0 ? <Row className="status-row" primary={<span className="task-meta">No closed tasks.</span>} /> : null}
                  {closedHasMore ? (
                    <Row
                      className="status-row"
                      primary={<span className="task-meta">Load additional closed tasks.</span>}
                      actions={[
                        {
                          icon: loadingClosedTasks ? "Loading..." : "Load more closed",
                          callbackFunc: () => void loadMoreClosedTasks(),
                          disabled: loadingClosedTasks,
                        },
                      ]}
                    />
                  ) : null}
                </RowStack>
              ) : null}
              </>
              ) : null}
            </Panel>
          ) : activePage === "analytics" ? (
            <Panel className="analytics-page">
              <Row
                className="section-head-row analytics-head"
                style="title"
                as="h1"
                primary={<span className="title">Analytics ({analyticsDays} days)</span>}
                alertText={loadingAnalytics ? <span className="task-meta">Loading...</span> : undefined}
                actions={[
                  { icon: "Last day", callbackFunc: () => setAnalyticsDays(1) },
                  { icon: "Last week", callbackFunc: () => setAnalyticsDays(7) },
                  { icon: "Last 30 days", callbackFunc: () => setAnalyticsDays(30) },
                ]}
              />
              {analytics ? (
                <Row
                  className="status-row"
                  primary={<span className="task-meta">Window: {analytics.window.startDate} to {analytics.window.endDate} ({analytics.window.timeZone})</span>}
                />
              ) : null}
              {analyticsError ? <Row className="status-row" primary={<span className="error-text">{analyticsError}</span>} /> : null}

              <Row className="section-head-row" style="title" as="h2" primary={<span className="title">Overview</span>} />

              <RowStack as="section" className="metrics-row-stack">
                <Row
                  className="metric-row"
                  primary={<span className="metric-label">Created</span>}
                  secondaryText={<strong className="metric-value">{analytics?.totals.createdInWindow ?? 0}</strong>}
                />
                <Row
                  className="metric-row"
                  primary={<span className="metric-label">Completed</span>}
                  secondaryText={<strong className="metric-value">{analytics?.totals.completedInWindow ?? 0}</strong>}
                />
                <Row
                  className="metric-row"
                  primary={<span className="metric-label">Open now</span>}
                  secondaryText={<strong className="metric-value">{analytics?.totals.openNow ?? 0}</strong>}
                />
                <Row
                  className="metric-row"
                  primary={<span className="metric-label">Overdue open</span>}
                  secondaryText={<strong className="metric-value">{analytics?.totals.overdueOpen ?? 0}</strong>}
                />
                <Row
                  className="metric-row"
                  primary={<span className="metric-label">Completion rate</span>}
                  secondaryText={<strong className="metric-value">{Math.round((analytics?.totals.completionRateInWindow ?? 0) * 100)}%</strong>}
                />
              </RowStack>

              <SubtlePanel>
                <Row
                  className="section-head-row analytics-head"
                  style="title"
                  as="h2"
                  primary={<span className="title">Daily throughput</span>}
                  secondaryText={
                    <span className="analytics-legend-row">
                      <span className="legend-item">
                        <span className="legend-swatch legend-created" /> Created
                      </span>
                      <span className="legend-item">
                        <span className="legend-swatch legend-completed" /> Completed
                      </span>
                    </span>
                  }
                />
                <div className="chart-grid" role="img" aria-label="Daily created and completed todos">
                  {dailyMetrics.map((point) => {
                    const createdHeight = `${Math.round((point.created / maxDailyMetric) * 100)}%`;
                    const completedHeight = `${Math.round((point.completed / maxDailyMetric) * 100)}%`;
                    const weekendClass = isWeekendDay(point.date) ? " chart-day-weekend" : "";
                    return (
                      <div className={`chart-day${weekendClass}`} key={point.date}>
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
              </SubtlePanel>

              <RowStack className="breakdown-grid">
                <SubtlePanel>
                  <Row className="section-head-row" style="title" as="h2" primary={<span className="title">By owner</span>} />
                  <RowStack className="breakdown-list breakdown-list-fixed breakdown-row-stack">
                    {analyticsOwnerBreakdown.map((entry) => (
                      <Row
                        key={entry.owner}
                        className="breakdown-row"
                        primary={<span>{entry.owner}</span>}
                        secondaryText={<span>open {entry.openNow} | +{entry.createdInWindow} / -{entry.completedInWindow}</span>}
                      />
                    ))}
                    {analyticsOwnerBreakdown.length === 0 ? <Row className="breakdown-row" primary={<span>No owner data.</span>} /> : null}
                  </RowStack>
                </SubtlePanel>

                <SubtlePanel>
                  <Row className="section-head-row" style="title" as="h2" primary={<span className="title">By project</span>} />
                  <RowStack className="breakdown-list breakdown-list-fixed breakdown-row-stack">
                    {analyticsProjectBreakdown.map((entry) => (
                      <Row
                        key={entry.projectTag}
                        className="breakdown-row"
                        primary={<span>{entry.projectTag}</span>}
                        secondaryText={<span>open {entry.openNow} | +{entry.createdInWindow} / -{entry.completedInWindow}</span>}
                      />
                    ))}
                    {analyticsProjectBreakdown.length === 0 ? <Row className="breakdown-row" primary={<span>No project data.</span>} /> : null}
                  </RowStack>
                </SubtlePanel>
              </RowStack>
            </Panel>
          ) : (
            <Panel className="user-page">
              <Row className="section-head-row" style="title" as="h1" primary={<span className="title">Settings</span>} />
              <Row className="section-head-row" style="title" as="h2" primary={<span className="title">API access</span>} />
              <RowStack>
                <Row className="settings-row" style="secondary" primary={<span>Use this token with the `Authorization: Bearer ...` header for CLI and API calls.</span>} />
                <Row className="settings-row" style="contrast" primary={<span>Keep it private. If leaked, rotate it from your environment configuration.</span>} />
                <Row
                  className="settings-row"
                  style="primary"
                  primary={
                    <>
                      <label className="token-label" htmlFor="token-field">Bearer token</label>
                      <input id="token-field" className="text-input" type="password" value={token ?? ""} readOnly />
                    </>
                  }
                  actions={[{ icon: copiedToken ? "Copied" : "Copy token", callbackFunc: token ? () => void copyToken() : undefined, disabled: !token }]}
                />
              </RowStack>
            </Panel>
          )}
        </Container>
      </Container>

      <Panel as="section" className="dock" aria-label="Control dock">
        <Row
          className="dock-row"
          density="compact"
          primary={<span className="task-meta">Session</span>}
          actions={[
            { icon: theme === "dark" ? "Light" : "Dark", callbackFunc: () => setTheme(theme === "dark" ? "light" : "dark") },
            { icon: "Exit", callbackFunc: () => void logout() },
          ]}
        />
      </Panel>
    </Container>
  );
}
