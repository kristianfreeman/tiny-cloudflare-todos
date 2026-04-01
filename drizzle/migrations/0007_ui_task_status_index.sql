CREATE INDEX IF NOT EXISTS idx_tasks_list_status_due_created_id
ON tasks(list_id, status, due_date, created_at, id);
