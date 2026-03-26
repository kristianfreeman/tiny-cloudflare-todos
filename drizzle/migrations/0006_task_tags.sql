CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);

CREATE INDEX idx_task_tags_user_tag_task ON task_tags(user_id, tag, task_id);
CREATE INDEX idx_task_tags_task ON task_tags(task_id);
