import { Action, ActionPanel, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import AddTaskCommand from "./add-task";
import {
  completeTask,
  getDefaultOwnerScope,
  getDefaultStatusFilter,
  listTasks,
  type OwnerScope,
  type TaskStatus,
  type TodoTask
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

const subtitle = (task: TodoTask): string => {
  const taskTags = Array.isArray(task.tags) ? task.tags : [];
  if (task.note && task.note.trim().length > 0) {
    return task.note;
  }

  if (taskTags.length > 0) {
    return taskTags.join(", ");
  }

  return dueLabel(task);
};

const matchesSearch = (task: TodoTask, query: string): boolean => {
  if (!query) {
    return true;
  }

  const tags = Array.isArray(task.tags) ? task.tags : [];
  const text = `${task.title}\n${task.note ?? ""}\n${tags.join(" ")}`.toLowerCase();
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

export default function ManageTasksCommand() {
  const { push } = useNavigation();
  const [viewFilter, setViewFilter] = useState<ViewFilter>(() => toViewFilter(getDefaultStatusFilter()));
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(() => getDefaultOwnerScope());
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
        message
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
    [tasks]
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
    [tasks, tagFilter, searchText]
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
      <Action title="Quick Add Task" icon={Icon.Plus} onAction={() => push(<AddTaskCommand />)} shortcut={{ modifiers: ["cmd"], key: "n" }} />
    </>
  );

  const accessoryForTask = (task: TodoTask): List.Item.Accessory[] => {
    const accessories: List.Item.Accessory[] = [{ text: dueLabel(task) }];
    const tags = Array.isArray(task.tags) ? task.tags : [];
    if (tags.length > 0) {
      accessories.unshift({ tag: tags.join(" · ") });
    }
    return accessories;
  };

  return (
    <List
      isLoading={isLoading}
      navigationTitle={ownerScopeTitle(ownerScope)}
      searchBarPlaceholder="Search tasks, notes, and tags"
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
      <List.Section title="Filters">
        <List.Item
          title="Owner Scope"
          subtitle={ownerScopeTitle(ownerScope)}
          icon={Icon.Person}
          actions={
            <ActionPanel>
              <Action title="Show All Tasks" onAction={() => setOwnerScope("all")} />
              <Action title="Show My Tasks" onAction={() => setOwnerScope("user")} />
              <Action title="Show Agent Tasks" onAction={() => setOwnerScope("agent")} />
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
              <Action title="Use Any Tag" onAction={() => setTagFilter("__all__")} />
              {availableTags.map((tag) => (
                <Action key={tag} title={`Filter by ${tag}`} onAction={() => setTagFilter(tag)} />
              ))}
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
            subtitle={subtitle(task)}
            accessories={accessoryForTask(task)}
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
