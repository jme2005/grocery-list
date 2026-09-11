-- Migration 6: Web Push subscriptions (one-time).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL
);
