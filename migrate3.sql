-- Migration 3: planned pickup time for claims ("will get Saturday").
-- Run once against the REMOTE database:
--   npx wrangler d1 execute grocery-list-db --remote --file=migrate3.sql
ALTER TABLE items ADD COLUMN claim_when TEXT;
