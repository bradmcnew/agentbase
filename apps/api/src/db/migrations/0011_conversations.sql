ALTER TABLE interactions ADD COLUMN conversation_id TEXT;
CREATE INDEX idx_interactions_conversation ON interactions(conversation_id, created_at);
