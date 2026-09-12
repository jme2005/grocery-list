-- Quantities, notes, price estimates, photos, claim expiry, staples.
ALTER TABLE items ADD COLUMN qty TEXT;
ALTER TABLE items ADD COLUMN note TEXT;
ALTER TABLE items ADD COLUMN price REAL;
ALTER TABLE items ADD COLUMN photo TEXT;
ALTER TABLE items ADD COLUMN claim_until TEXT;
CREATE TABLE IF NOT EXISTS staples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT 'either',
  qty TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
