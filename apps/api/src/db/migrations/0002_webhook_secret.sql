-- Webhook signing secret for external endpoints
ALTER TABLE endpoints ADD COLUMN webhook_secret TEXT;
