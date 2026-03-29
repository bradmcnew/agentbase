-- Drop and recreate tables to remove legacy columns
-- Order matters: drop interactions first (references endpoints)

-- Save interactions data
CREATE TABLE interactions_backup AS SELECT id, endpoint_id, query, response, tokens_input, tokens_output, latency_ms, confidence, confidence_sources, created_at FROM interactions;

-- Save endpoints data
CREATE TABLE endpoints_backup AS SELECT id, account_id, slug, name, description, webhook_url, webhook_secret, capabilities, system_prompt, skill_md, external_model, external_api_key, custom_domain, query_count, query_count_reset_at, status, created_at FROM endpoints;

-- Drop both (interactions first due to FK)
DROP TABLE interactions;
DROP TABLE endpoints;

-- Recreate endpoints (clean schema, no legacy columns)
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL DEFAULT 'external',
  webhook_url TEXT,
  webhook_secret TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT,
  skill_md TEXT,
  external_model TEXT,
  external_api_key TEXT,
  custom_domain TEXT,
  query_count INTEGER NOT NULL DEFAULT 0,
  query_count_reset_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO endpoints SELECT id, account_id, slug, name, description, 'external', webhook_url, webhook_secret, capabilities, system_prompt, skill_md, external_model, external_api_key, custom_domain, query_count, query_count_reset_at, status, created_at FROM endpoints_backup;

-- Recreate interactions (clean schema, no sources column)
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  query TEXT NOT NULL,
  response TEXT NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,
  confidence TEXT,
  confidence_sources TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO interactions SELECT * FROM interactions_backup;

-- Recreate indexes
CREATE UNIQUE INDEX idx_endpoints_account_slug ON endpoints(account_id, slug);
CREATE INDEX idx_endpoints_custom_domain ON endpoints(custom_domain);
CREATE INDEX idx_interactions_endpoint ON interactions(endpoint_id, created_at);

-- Clean up backups
DROP TABLE endpoints_backup;
DROP TABLE interactions_backup;
