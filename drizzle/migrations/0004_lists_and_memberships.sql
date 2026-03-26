CREATE TABLE lists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE list_memberships (
  list_id TEXT NOT NULL REFERENCES lists(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (list_id, user_id)
);

INSERT OR IGNORE INTO lists (id, name, created_by_user_id, created_at, updated_at)
SELECT
  'default:' || users.id,
  'Default',
  users.id,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users;

INSERT OR IGNORE INTO list_memberships (list_id, user_id, role, created_at, updated_at)
SELECT
  'default:' || users.id,
  users.id,
  'owner',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users;

ALTER TABLE tasks
  ADD COLUMN list_id TEXT NOT NULL DEFAULT 'default:legacy-single-tenant' REFERENCES lists(id);

ALTER TABLE recurrence_rules
  ADD COLUMN list_id TEXT NOT NULL DEFAULT 'default:legacy-single-tenant' REFERENCES lists(id);

UPDATE tasks
SET list_id = 'default:' || user_id
WHERE list_id IS NULL OR list_id = '' OR list_id = 'default:legacy-single-tenant';

UPDATE recurrence_rules
SET list_id = 'default:' || user_id
WHERE list_id IS NULL OR list_id = '' OR list_id = 'default:legacy-single-tenant';

CREATE INDEX idx_lists_created_by_user ON lists(created_by_user_id);
CREATE INDEX idx_list_memberships_user ON list_memberships(user_id);
CREATE INDEX idx_tasks_list_status ON tasks(list_id, status);
CREATE INDEX idx_tasks_list_due_date ON tasks(list_id, due_date);
CREATE INDEX idx_recurrence_list_next_run_date ON recurrence_rules(list_id, next_run_date);
CREATE INDEX idx_recurrence_list_active ON recurrence_rules(list_id, active);

DROP INDEX IF EXISTS idx_tasks_user_recurrence_due_date;

CREATE UNIQUE INDEX idx_tasks_list_recurrence_due_date
ON tasks(list_id, recurrence_rule_id, due_date)
WHERE recurrence_rule_id IS NOT NULL AND due_date IS NOT NULL;
