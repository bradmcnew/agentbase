-- Add endpoint modes: platform (default), byok, external
ALTER TABLE endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE endpoints ADD COLUMN webhook_url TEXT;
ALTER TABLE endpoints ADD COLUMN llm_provider TEXT;
ALTER TABLE endpoints ADD COLUMN llm_api_key TEXT;
ALTER TABLE endpoints ADD COLUMN llm_model TEXT;
