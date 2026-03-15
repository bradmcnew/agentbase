-- Custom domain support for endpoints
ALTER TABLE endpoints ADD COLUMN custom_domain TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoints_custom_domain ON endpoints(custom_domain);
