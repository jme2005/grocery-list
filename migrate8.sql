-- Adds push_sent_at so notification pushes can be delayed until a burst of
-- activity goes quiet: one push per batch instead of one push per item.
-- Existing rows are marked sent so the first cron flush doesn't re-push them.
ALTER TABLE notification_events ADD COLUMN push_sent_at TEXT;
UPDATE notification_events SET push_sent_at = created_at WHERE push_sent_at IS NULL;
