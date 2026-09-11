-- Migration 4: urgent flag (highlight must-buy items, sort them first).
-- Run once against the REMOTE database:
--   npx wrangler d1 execute grocery-list-db --remote --file=migrate4.sql
ALTER TABLE items ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
