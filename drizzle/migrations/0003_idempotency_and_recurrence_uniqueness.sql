CREATE TABLE idempotency_records (
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key, method, path)
);

CREATE INDEX idx_idempotency_expires_at ON idempotency_records(expires_at);

CREATE UNIQUE INDEX idx_tasks_user_recurrence_due_date
ON tasks(user_id, recurrence_rule_id, due_date)
WHERE recurrence_rule_id IS NOT NULL AND due_date IS NOT NULL;
