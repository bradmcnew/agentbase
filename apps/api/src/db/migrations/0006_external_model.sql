-- External mode: model name and encrypted API key for OpenAI-compatible endpoints
ALTER TABLE endpoints ADD COLUMN external_model TEXT;
ALTER TABLE endpoints ADD COLUMN external_api_key TEXT;
