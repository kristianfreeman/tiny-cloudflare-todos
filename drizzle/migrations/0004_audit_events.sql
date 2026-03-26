CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_events_actor_created_at ON audit_events(actor_user_id, created_at);
CREATE INDEX idx_audit_events_resource_created_at ON audit_events(resource_type, resource_id, created_at);
