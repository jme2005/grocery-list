CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'either' CHECK (store IN ('heb', 'tjs', 'either')),
  checked INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  purchased_by TEXT,
  purchased_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_checked_created ON items (checked, created_at);
