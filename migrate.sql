-- Migration for databases created with the original schema (Sep 2026).
-- Adds who/when attribution for added and purchased items.
-- Run once against the REMOTE database:
--   npx wrangler d1 execute grocery-list-db --remote --file=migrate.sql
ALTER TABLE items ADD COLUMN added_by TEXT;
ALTER TABLE items ADD COLUMN purchased_by TEXT;
ALTER TABLE items ADD COLUMN purchased_at TEXT;
