-- Migration 2: claim attribution (who grabbed what, and when).
-- Run once against the REMOTE database:
--   npx wrangler d1 execute grocery-list-db --remote --file=migrate2.sql
ALTER TABLE items ADD COLUMN claimed_by TEXT;
ALTER TABLE items ADD COLUMN claimed_at TEXT;
