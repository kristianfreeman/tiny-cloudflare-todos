import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import AddTaskCommand from "./add-task";
import {
  completeTask,
  listTasks,
  reopenTask,
  type TaskStatus,
  type TodoTask,
} from "./api";

interface TasksByTagProps {
  arguments: {
    tag: string;
  };
}

const dueLabel = (task: TodoTask): string =>
  task.dueDate ? `Due ${task.dueDate}` : "No due date";

const tagsLabel = (task: TodoTask): string => {
  const taskTags = Array.isArray(task.tags) ? task.tags : [];
  return taskTags.length > 0 ? taskTags.join(" · ") : "No tags";
};

const detailMarkdown = (task: TodoTask): string => {
  const note = task.note?.trim();
  if (note && note.length > 0) {
    return note;
  }
  return "_No notes_";
};

const compareTasks = (left: TodoTask, right: TodoTask): number => {
  const leftDue = left.dueDate ?? "9999-12-31";
  const rightDue = right.dueDate ?? "9999-12-31";
  if (leftDue !== rightDue) {
    return leftDue.localeCompare(rightDue);
  }
  return left.title.localeCompare(right.title);
};

interface TaskDetailViewProps {
  task: TodoTask;
  onCompleteTask: (task: TodoTask) => Promise<void>;
  onReopenTask: (task: TodoTask) => Promise<void>;
  onRefresh: () => Promise<void>;
  onQuickAdd: () => void;
}

const TaskDetailView = ({
  task,
  onCompleteTask,
  onReopenTask,
  onRefresh,
  onQuickAdd,
}: TaskDetailViewProps) => {
  const { pop } = useNavigation();

  const handleComplete = async (): Promise<void> => {
    await onCompleteTask(task);
    pop();
  };

  const handleReopen = async (): Promise<void> => {
    await onReopenTask(task);
    pop();
  };

  return (
    <Detail
      navigationTitle="Task Details"
      markdown={detailMarkdown(task)}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Title" text={task.title} />
          <Detail.Metadata.Label
            title="Status"
            text={task.status === "done" ? "Done" : "Open"}
          />
          <Detail.Metadata.Label title="Due" text={dueLabel(task)} />
          <Detail.Metadata.Label title="Tags" text={tagsLabel(task)} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Task ID" text={task.id} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {task.status === "open" ? (
            <Action
              title="Complete Task"
              icon={Icon.Checkmark}
              onAction={() => void handleComplete()}
            />
          ) : (
            <Action
              title="Mark as Incomplete"
              icon={Icon.ArrowClockwise}
              onAction={() => void handleReopen()}
            />
          )}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={() => void onRefresh()}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
          <Action
            title="Quick Add Task"
            icon={Icon.Plus}
            onAction={onQuickAdd}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
          />
          <Action.CopyToClipboard title="Copy Task ID" content={task.id} />
        </ActionPanel>
      }
    />
  );
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
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load tagged tasks",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [status, tag]);

  const sortedTasks = useMemo(() => [...tasks].sort(compareTasks), [tasks]);

  const onCompleteTask = async (task: TodoTask): Promise<void> => {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Completing task...",
    });
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

  const onReopenTask = async (task: TodoTask): Promise<void> => {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Marking task as incomplete...",
    });
    try {
      await reopenTask(task.id);
      toast.style = Toast.Style.Success;
      toast.title = "Task marked incomplete";
      await loadTasks();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to update task";
      toast.message = message;
    }
  };

  const accessoryForTask = (task: TodoTask): List.Item.Accessory[] => {
    const accessories: List.Item.Accessory[] = [{ text: dueLabel(task) }];
    const tags = Array.isArray(task.tags) ? task.tags : [];
    if (tags.length > 0) {
      accessories.unshift({ tag: tags.join(" · ") });
    }
    if (task.status === "done") {
      accessories.push({ icon: Icon.CheckCircle, text: "Done" });
    }
    return accessories;
  };

  const actions = (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={() => void loadTasks()}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
      />
      <Action
        title="Quick Add Task"
        icon={Icon.Plus}
        onAction={() => push(<AddTaskCommand />)}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
      />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      navigationTitle={tag ? `Tag: ${tag}` : "Tasks by Tag"}
      searchBarPlaceholder={
        tag ? `Tasks tagged ${tag}` : "Enter a tag argument"
      }
      searchBarAccessory={
        <List.Dropdown
          tooltip="Status"
          value={status}
          onChange={(value) => setStatus(value as TaskStatus)}
        >
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
          accessories={accessoryForTask(task)}
          actions={
            <ActionPanel>
              <Action.Push
                title="Open Task Details"
                icon={Icon.Document}
                target={
                  <TaskDetailView
                    task={task}
                    onCompleteTask={onCompleteTask}
                    onReopenTask={onReopenTask}
                    onRefresh={loadTasks}
                    onQuickAdd={() => push(<AddTaskCommand />)}
                  />
                }
              />
              {task.status === "open" ? (
                <Action
                  title="Complete Task"
                  onAction={() => void onCompleteTask(task)}
                />
              ) : (
                <Action
                  title="Mark as Incomplete"
                  onAction={() => void onReopenTask(task)}
                />
              )}
              <Action.CopyToClipboard title="Copy Task ID" content={task.id} />
              {actions}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
