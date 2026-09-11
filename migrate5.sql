-- Migration 5: allow 'costco' as a store.
-- The original table has CHECK (store IN ('heb','tjs','either')), which SQLite
-- will not let us widen in place, so we rebuild the table and copy the data.
-- Paste the whole file into the D1 console at dash.cloudflare.com
-- (Workers & Pages > D1 > grocery-list-db > Console) and run it. Run once.
CREATE TABLE items_new (
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
  purchased_at TEXT
);
INSERT INTO items_new (id, name, store, checked, urgent, added_by, claimed_by, claimed_at, claim_when, created_at, updated_at, purchased_by, purchased_at)
  SELECT id, name, store, checked, urgent, added_by, claimed_by, claimed_at, claim_when, created_at, updated_at, purchased_by, purchased_at FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX IF NOT EXISTS idx_items_checked_created ON items (checked, created_at);
