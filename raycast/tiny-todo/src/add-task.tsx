import { Action, ActionPanel, Form, showToast, Toast, useNavigation } from "@raycast/api";
import { createTask } from "./api";

interface AddTaskFormValues {
  title: string;
  note?: string;
  dueDate?: Date;
}

const formatDateForApi = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export default function AddTaskCommand() {
  const { pop } = useNavigation();

  const onSubmit = async (values: AddTaskFormValues): Promise<void> => {
    if (!values.title?.trim()) {
      await showToast({ style: Toast.Style.Failure, title: "Title is required" });
      return;
    }

    const toast = await showToast({ style: Toast.Style.Animated, title: "Creating task..." });

    try {
      await createTask({
        title: values.title.trim(),
        note: values.note?.trim() || undefined,
        dueDate: values.dueDate ? formatDateForApi(values.dueDate) : undefined
      });
      toast.style = Toast.Style.Success;
      toast.title = "Task created";
      pop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to create task";
      toast.message = message;
    }
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Task" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" placeholder="Write docs" />
      <Form.TextArea id="note" title="Note" placeholder="Optional task details" />
      <Form.DatePicker id="dueDate" title="Due Date" type={Form.DatePicker.Type.Date} />
    </Form>
  );
}
