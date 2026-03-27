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
  getDefaultOwnerScope,
  getDefaultStatusFilter,
  listTasks,
  type OwnerScope,
  reopenTask,
  type TaskStatus,
  type TodoTask,
} from "./api";

type ViewFilter = "open" | "done" | "all";
type TagFilter = "__all__" | string;

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

const matchesSearch = (task: TodoTask, query: string): boolean => {
  if (!query) {
    return true;
  }

  const tags = Array.isArray(task.tags) ? task.tags : [];
  const text =
    `${task.title}\n${task.note ?? ""}\n${tags.join(" ")}`.toLowerCase();
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

const ownerScopeToTags = (scope: OwnerScope): string[] | undefined => {
  if (scope === "user") {
    return ["owner:user"];
  }
  if (scope === "agent") {
    return ["owner:agent"];
  }
  return undefined;
};

const ownerScopeTitle = (scope: OwnerScope): string => {
  if (scope === "user") {
    return "My Tasks";
  }
  if (scope === "agent") {
    return "Agent Tasks";
  }
  return "All Tasks";
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

export default function ManageTasksCommand() {
  const { push } = useNavigation();
  const [viewFilter, setViewFilter] = useState<ViewFilter>(() =>
    toViewFilter(getDefaultStatusFilter()),
  );
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(() =>
    getDefaultOwnerScope(),
  );
  const [tagFilter, setTagFilter] = useState<TagFilter>("__all__");
  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const loadTasks = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const status: TaskStatus = viewFilter;
      const nextTasks = await listTasks(status, ownerScopeToTags(ownerScope));
      setTasks(nextTasks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load tasks",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [viewFilter, ownerScope]);

  const availableTags = useMemo(
    () =>
      [...new Set(tasks.flatMap((task) => task.tags))]
        .filter((tag): tag is string => typeof tag === "string")
        .filter((tag) => !tag.startsWith("owner:"))
        .sort((left, right) => left.localeCompare(right)),
    [tasks],
  );

  useEffect(() => {
    if (tagFilter !== "__all__" && !availableTags.includes(tagFilter)) {
      setTagFilter("__all__");
    }
  }, [availableTags, tagFilter]);

  const filtered = useMemo(
    () =>
      tasks
        .filter((task) => {
          if (tagFilter === "__all__") {
            return true;
          }
          const tags = Array.isArray(task.tags) ? task.tags : [];
          return tags.includes(tagFilter);
        })
        .filter((task) => matchesSearch(task, searchText))
        .sort(compareTasks),
    [tasks, tagFilter, searchText],
  );

  const openTasks = filtered.filter((task) => task.status === "open");
  const doneTasks = filtered.filter((task) => task.status === "done");

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

  const commonActions = (
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

  const cycleOwnerScope = (): void => {
    setOwnerScope((current) => {
      if (current === "all") {
        return "user";
      }
      if (current === "user") {
        return "agent";
      }
      return "all";
    });
  };

  const cycleTagFilter = (): void => {
    const options: TagFilter[] = ["__all__", ...availableTags];
    if (options.length <= 1) {
      setTagFilter("__all__");
      return;
    }
    const currentIndex = options.indexOf(tagFilter);
    const nextIndex =
      currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
    setTagFilter(options[nextIndex] ?? "__all__");
  };

  const accessoryForTask = (
    task: TodoTask,
    options?: { includeDoneBadge?: boolean },
  ): List.Item.Accessory[] => {
    const accessories: List.Item.Accessory[] = [{ text: dueLabel(task) }];
    const tags = Array.isArray(task.tags) ? task.tags : [];
    if (tags.length > 0) {
      accessories.unshift({ tag: tags.join(" · ") });
    }
    if (options?.includeDoneBadge) {
      accessories.push({ icon: Icon.CheckCircle, text: "Done" });
    }
    return accessories;
  };

  return (
    <List
      isLoading={isLoading}
      navigationTitle={ownerScopeTitle(ownerScope)}
      searchBarPlaceholder="Search tasks and tags"
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Status"
          value={viewFilter}
          onChange={(value) => setViewFilter(value as ViewFilter)}
        >
          <List.Dropdown.Item title="Open" value="open" />
          <List.Dropdown.Item title="Done" value="done" />
          <List.Dropdown.Item title="All" value="all" />
        </List.Dropdown>
      }
    >
      <List.Section title="Filters">
        <List.Item
          title="Owner Scope"
          subtitle={ownerScopeTitle(ownerScope)}
          icon={Icon.Person}
          actions={
            <ActionPanel>
              <Action title="Cycle Owner Scope" onAction={cycleOwnerScope} />
              <ActionPanel.Submenu title="Set Owner Scope" icon={Icon.Person}>
                <Action
                  title="Show All Tasks"
                  onAction={() => setOwnerScope("all")}
                />
                <Action
                  title="Show My Tasks"
                  onAction={() => setOwnerScope("user")}
                />
                <Action
                  title="Show Agent Tasks"
                  onAction={() => setOwnerScope("agent")}
                />
              </ActionPanel.Submenu>
              {commonActions}
            </ActionPanel>
          }
        />
        <List.Item
          title="Tag Filter"
          subtitle={tagFilter === "__all__" ? "Any tag" : tagFilter}
          icon={Icon.Tag}
          actions={
            <ActionPanel>
              <Action title="Cycle Tag Filter" onAction={cycleTagFilter} />
              <ActionPanel.Submenu title="Set Tag Filter" icon={Icon.Tag}>
                <Action
                  title="Use Any Tag"
                  onAction={() => setTagFilter("__all__")}
                />
                {availableTags.map((tag) => (
                  <Action
                    key={tag}
                    title={`Filter by ${tag}`}
                    onAction={() => setTagFilter(tag)}
                  />
                ))}
              </ActionPanel.Submenu>
              {commonActions}
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="Open" subtitle={String(openTasks.length)}>
        {openTasks.map((task) => (
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
                <Action
                  title="Complete Task"
                  icon={Icon.Checkmark}
                  onAction={() => void onCompleteTask(task)}
                />
                <Action.CopyToClipboard
                  title="Copy Task ID"
                  content={task.id}
                />
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
            accessories={accessoryForTask(task, { includeDoneBadge: true })}
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
                <Action
                  title="Mark as Incomplete"
                  icon={Icon.ArrowClockwise}
                  onAction={() => void onReopenTask(task)}
                />
                <Action.CopyToClipboard
                  title="Copy Task ID"
                  content={task.id}
                />
                {commonActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
