CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  plan TEXT NOT NULL DEFAULT 'free'
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_api_keys_account ON api_keys(account_id);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  azure_index_name TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT,
  skill_md TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, slug)
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  query TEXT NOT NULL,
  response TEXT NOT NULL,
  sources TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_interactions_endpoint ON interactions(endpoint_id, created_at);
