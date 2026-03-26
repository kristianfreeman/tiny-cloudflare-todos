import { Action, ActionPanel, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import AddTaskCommand from "./add-task";
import { completeTask, listTasks, type TaskStatus, type TodoTask } from "./api";

interface TasksByTagProps {
  arguments: {
    tag: string;
  };
}

const dueLabel = (task: TodoTask): string => (task.dueDate ? `Due ${task.dueDate}` : "No due date");

const compareTasks = (left: TodoTask, right: TodoTask): number => {
  const leftDue = left.dueDate ?? "9999-12-31";
  const rightDue = right.dueDate ?? "9999-12-31";
  if (leftDue !== rightDue) {
    return leftDue.localeCompare(rightDue);
  }
  return left.title.localeCompare(right.title);
};

export default function TasksByTagCommand(props: TasksByTagProps) {
  const { push } = useNavigation();
  const tag = props.arguments.tag.trim().toLowerCase();
  const [status, setStatus] = useState<TaskStatus>("open");
  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadTasks = async (): Promise<void> => {
    if (!tag) {
      setTasks([]);
      return;
    }

    setIsLoading(true);
    try {
      const nextTasks = await listTasks(status, [tag]);
      setTasks(nextTasks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({ style: Toast.Style.Failure, title: "Failed to load tagged tasks", message });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [status, tag]);

  const sortedTasks = useMemo(() => [...tasks].sort(compareTasks), [tasks]);

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

  const actions = (
    <>
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => void loadTasks()} shortcut={{ modifiers: ["cmd"], key: "r" }} />
      <Action title="Quick Add Task" icon={Icon.Plus} onAction={() => push(<AddTaskCommand />)} shortcut={{ modifiers: ["cmd"], key: "n" }} />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      navigationTitle={tag ? `Tag: ${tag}` : "Tasks by Tag"}
      searchBarPlaceholder={tag ? `Tasks tagged ${tag}` : "Enter a tag argument"}
      searchBarAccessory={
        <List.Dropdown tooltip="Status" value={status} onChange={(value) => setStatus(value as TaskStatus)}>
          <List.Dropdown.Item title="Open" value="open" />
          <List.Dropdown.Item title="Done" value="done" />
          <List.Dropdown.Item title="All" value="all" />
        </List.Dropdown>
      }
    >
      {sortedTasks.map((task) => (
        <List.Item
          key={task.id}
          title={task.title}
          subtitle={task.note ?? ""}
          accessories={[{ text: dueLabel(task) }]}
          actions={
            <ActionPanel>
              {task.status === "open" ? <Action title="Complete Task" onAction={() => void onCompleteTask(task)} /> : null}
              <Action.CopyToClipboard title="Copy Task ID" content={task.id} />
              {actions}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
