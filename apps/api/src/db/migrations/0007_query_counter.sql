-- Per-endpoint daily query counter for public query rate limiting
-- query_count resets when query_count_reset_at (unix ms timestamp) is passed
ALTER TABLE endpoints ADD COLUMN query_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE endpoints ADD COLUMN query_count_reset_at INTEGER NOT NULL DEFAULT 0;
