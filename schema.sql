CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'either' CHECK (store IN ('heb', 'tjs', 'costco', 'either')),
  checked INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  claim_when TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  purchased_by TEXT,
  purchased_at TEXT,
  qty TEXT,
  note TEXT,
  price REAL,
  photo TEXT,
  claim_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_checked_created ON items (checked, created_at);
CREATE TABLE IF NOT EXISTS staples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'either',
  qty TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
