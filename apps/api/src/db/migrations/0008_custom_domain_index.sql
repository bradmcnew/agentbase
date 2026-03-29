-- Index for custom domain hostname lookups (used on every custom domain request)
CREATE INDEX IF NOT EXISTS idx_endpoints_custom_domain ON endpoints(custom_domain);
