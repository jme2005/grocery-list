-- Department overrides: learned corrections for automatic department grouping.
-- Keyed by lowercased item name; shared across both phones.
CREATE TABLE IF NOT EXISTS dept_overrides (
  name TEXT PRIMARY KEY,
  dept TEXT NOT NULL
);
