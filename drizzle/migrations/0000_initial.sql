CREATE TABLE recurrence_rules (
  id TEXT PRIMARY KEY NOT NULL,
  title_template TEXT NOT NULL,
  note_template TEXT,
  cadence TEXT NOT NULL,
  interval INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  anchor_date TEXT NOT NULL,
  next_run_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  recurrence_rule_id TEXT REFERENCES recurrence_rules(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_recurrence_next_run_date ON recurrence_rules(next_run_date);
CREATE INDEX idx_recurrence_active ON recurrence_rules(active);
