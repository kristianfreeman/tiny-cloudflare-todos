CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);

INSERT INTO users (id, email, display_name, active, created_at, updated_at)
VALUES (
  'legacy-single-tenant',
  NULL,
  'Legacy Single Tenant',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE tasks
  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-single-tenant' REFERENCES users(id);

ALTER TABLE recurrence_rules
  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-single-tenant' REFERENCES users(id);

UPDATE tasks
SET user_id = 'legacy-single-tenant'
WHERE user_id IS NULL OR user_id = '';

UPDATE recurrence_rules
SET user_id = 'legacy-single-tenant'
WHERE user_id IS NULL OR user_id = '';

CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_user_due_date ON tasks(user_id, due_date);
CREATE INDEX idx_recurrence_user_next_run_date ON recurrence_rules(user_id, next_run_date);
CREATE INDEX idx_recurrence_user_active ON recurrence_rules(user_id, active);
