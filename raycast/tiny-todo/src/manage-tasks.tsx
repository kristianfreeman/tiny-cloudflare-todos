import { Action, ActionPanel, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import AddTaskCommand from "./add-task";
import { completeTask, getDefaultStatusFilter, listTasks, type TaskStatus, type TodoTask } from "./api";

type ViewFilter = "open" | "done" | "all";

const toViewFilter = (status: TaskStatus): ViewFilter => {
  if (status === "all" || status === "done") {
    return status;
  }

  return "open";
};

const dueLabel = (task: TodoTask): string => {
  if (!task.dueDate) {
    return "No due date";
  }

  return `Due ${task.dueDate}`;
};

const subtitle = (task: TodoTask): string => {
  if (task.note && task.note.trim().length > 0) {
    return task.note;
  }

  return dueLabel(task);
};

const matchesSearch = (task: TodoTask, query: string): boolean => {
  if (!query) {
    return true;
  }

  const text = `${task.title}\n${task.note ?? ""}`.toLowerCase();
  return text.includes(query.toLowerCase());
};

const compareTasks = (left: TodoTask, right: TodoTask): number => {
  const leftDue = left.dueDate ?? "9999-12-31";
  const rightDue = right.dueDate ?? "9999-12-31";

  if (leftDue !== rightDue) {
    return leftDue.localeCompare(rightDue);
  }

  return left.title.localeCompare(right.title);
};

export default function ManageTasksCommand() {
  const { push } = useNavigation();
  const [viewFilter, setViewFilter] = useState<ViewFilter>(() => toViewFilter(getDefaultStatusFilter()));
  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const loadTasks = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const status: TaskStatus = viewFilter;
      const nextTasks = await listTasks(status);
      setTasks(nextTasks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load tasks",
        message
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [viewFilter]);

  const filtered = useMemo(
    () => tasks.filter((task) => matchesSearch(task, searchText)).sort(compareTasks),
    [tasks, searchText]
  );

  const openTasks = filtered.filter((task) => task.status === "open");
  const doneTasks = filtered.filter((task) => task.status === "done");

  const onCompleteTask = async (task: TodoTask): Promise<void> => {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Completing task..." });

    try {
      await completeTask(task.id);
      toast.style = Toast.Style.Success;
      toast.title = "Task completed";
      await loadTasks();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to complete task";
      toast.message = message;
    }
  };

  const commonActions = (
    <>
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => void loadTasks()} shortcut={{ modifiers: ["cmd"], key: "r" }} />
      <Action title="Add Task" icon={Icon.Plus} onAction={() => push(<AddTaskCommand />)} shortcut={{ modifiers: ["cmd"], key: "n" }} />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search tasks by title or note"
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown tooltip="Status" value={viewFilter} onChange={(value) => setViewFilter(value as ViewFilter)}>
          <List.Dropdown.Item title="Open" value="open" />
          <List.Dropdown.Item title="Done" value="done" />
          <List.Dropdown.Item title="All" value="all" />
        </List.Dropdown>
      }
    >
      <List.Section title="Open" subtitle={String(openTasks.length)}>
        {openTasks.map((task) => (
          <List.Item
            key={task.id}
            title={task.title}
            subtitle={subtitle(task)}
            accessories={[{ text: dueLabel(task) }]}
            actions={
              <ActionPanel>
                <Action title="Complete Task" icon={Icon.Checkmark} onAction={() => void onCompleteTask(task)} />
                <Action.CopyToClipboard title="Copy Task ID" content={task.id} />
                {commonActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Done" subtitle={String(doneTasks.length)}>
        {doneTasks.map((task) => (
          <List.Item
            key={task.id}
            title={task.title}
            subtitle={subtitle(task)}
            accessories={[{ icon: Icon.CheckCircle, text: "Done" }]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Task ID" content={task.id} />
                {commonActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
