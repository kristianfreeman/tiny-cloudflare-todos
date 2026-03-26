CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due_created_id
ON tasks(user_id, status, due_date, created_at, id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_list_status_due_created_id
ON tasks(user_id, list_id, status, due_date, created_at, id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_created_id
ON tasks(user_id, created_at, id);
