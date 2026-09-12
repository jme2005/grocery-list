-- migrate7: notification activity feed (batching + unread marker).
-- One row per actor+kind batch; upsertEvent() coalesces rapid successive
-- events so a set of items produces a single notification.
CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  names TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_events_actor_kind_updated
  ON notification_events(actor, kind, updated_at);
