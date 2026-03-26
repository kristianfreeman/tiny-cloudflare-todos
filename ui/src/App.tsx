import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Badge, Button, ClipboardText, Input, SensitiveInput, Tabs, Text } from "@cloudflare/kumo";

interface Task {
  id: string;
  title: string;
  note: string | null;
  dueDate: string | null;
  status: "open" | "done";
}

interface TasksResponse {
  tasks: Task[];
}

type Page = "tasks" | "user";

const readError = async (response: Response): Promise<string> => {
  const fallback = `Request failed (${response.status})`;
  try {
    const parsed = (await response.json()) as { error?: string };
    return parsed.error ?? fallback;
  } catch {
    return fallback;
  }
};

export function App() {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNote, setTaskNote] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<Page>("tasks");
  const [token, setToken] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const openTasks = useMemo(() => tasks.filter((task) => task.status === "open"), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.status === "done"), [tasks]);

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
      const message = await readError(response);
      setTaskError(message.includes("invalid bearer token") ? "UI bearer token is invalid for local DB." : message);
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

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void loadTasks();
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
    setTasks([]);
  };

  const createTask = async (): Promise<void> => {
    if (!taskTitle.trim()) {
      setTaskError("Title is required.");
      return;
    }
    const response = await fetch("/ui/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: taskTitle.trim(),
        note: taskNote.trim() || undefined,
        dueDate: taskDueDate || undefined
      })
    });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    setTaskTitle("");
    setTaskNote("");
    setTaskDueDate("");
    await loadTasks();
  };

  const completeTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}/complete`, { method: "POST" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await loadTasks();
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
    await loadTasks();
  };

  const deleteTask = async (id: string): Promise<void> => {
    const response = await fetch(`/ui/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      setTaskError(await readError(response));
      return;
    }
    await loadTasks();
  };

  if (!sessionChecked) {
    return <main className="app-shell">Checking session...</main>;
  }

  if (!authenticated) {
    return (
      <main className="app-shell app-auth-shell">
        <section className="card auth-card">
          <h1 className="title">Tiny Todo Web</h1>
          <Text as="p">Sign in with the separate UI password.</Text>
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
        <Text as="p">Kumo controls + lightweight layout.</Text>
        <div className="badge-row">
          <Badge>{openTasks.length} open</Badge>
          <Badge>{doneTasks.length} done</Badge>
        </div>
        <div className="top-controls">
          <Tabs
            tabs={[
              { value: "tasks", label: "Tasks" },
              { value: "user", label: "User" }
            ]}
            value={activePage}
            onValueChange={(value) => setActivePage(value as Page)}
          />
          <Button onClick={() => void logout()}>Logout</Button>
        </div>
      </section>

      {activePage === "tasks" ? (
        <>
          <section className="card">
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
                type="date"
                value={taskDueDate}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setTaskDueDate(event.currentTarget.value)}
              />
              <Button onClick={() => void createTask()}>Add task</Button>
            </div>
          </section>

          <section className="card">
            <h2>Tasks</h2>
            {taskError ? <p className="error-text">{taskError}</p> : null}
            {loadingTasks ? <Text as="p">Loading tasks...</Text> : null}
            <ul className="task-list">
              {tasks.map((task) => (
                <li className="task-item" key={task.id}>
                  <Input
                    defaultValue={task.title}
                    disabled={task.status === "done"}
                    onBlur={(event: ChangeEvent<HTMLInputElement>) => void updateTaskTitle(task, event.currentTarget.value)}
                  />
                  <Badge>{task.status}</Badge>
                  <Text as="span">{task.dueDate ?? "No due date"}</Text>
                  <div className="task-item-actions">
                    <Button onClick={() => void completeTask(task.id)} disabled={task.status === "done"}>
                      Complete
                    </Button>
                    <Button onClick={() => void deleteTask(task.id)}>Delete</Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <section className="card">
          <h2>User token</h2>
          <SensitiveInput label="Bearer token" value={token ?? ""} readOnly />
          {token ? <ClipboardText text={token} tooltip={{ text: "Copy token", copiedText: "Token copied" }} /> : null}
        </section>
      )}
    </main>
  );
}
