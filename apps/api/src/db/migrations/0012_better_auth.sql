-- Drop existing tables in FK-safe order
DROP TABLE IF EXISTS `interactions`;
DROP TABLE IF EXISTS `endpoints`;
DROP TABLE IF EXISTS `accounts`;

-- Better Auth tables
CREATE TABLE `user` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `email` TEXT NOT NULL,
  `emailVerified` INTEGER NOT NULL DEFAULT 0,
  `name` TEXT,
  `image` TEXT,
  `plan` TEXT NOT NULL DEFAULT 'free',
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);

CREATE TABLE `session` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `expiresAt` INTEGER NOT NULL,
  `token` TEXT NOT NULL,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL,
  `ipAddress` TEXT,
  `userAgent` TEXT,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`)
);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);

CREATE TABLE `account` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `accountId` TEXT NOT NULL,
  `providerId` TEXT NOT NULL,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`),
  `accessToken` TEXT,
  `refreshToken` TEXT,
  `idToken` TEXT,
  `expiresAt` INTEGER,
  `password` TEXT,
  `createdAt` INTEGER NOT NULL,
  `updatedAt` INTEGER NOT NULL
);

CREATE TABLE `verification` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `identifier` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `expiresAt` INTEGER NOT NULL,
  `createdAt` INTEGER,
  `updatedAt` INTEGER
);

-- Recreated AgentBase tables with user_id
CREATE TABLE `endpoints` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL,
  `slug` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT,
  `mode` TEXT NOT NULL DEFAULT 'external',
  `webhook_url` TEXT,
  `webhook_secret` TEXT,
  `capabilities` TEXT NOT NULL DEFAULT '[]',
  `system_prompt` TEXT,
  `skill_md` TEXT,
  `external_model` TEXT,
  `external_api_key` TEXT,
  `custom_domain` TEXT,
  `query_count` INTEGER NOT NULL DEFAULT 0,
  `query_count_reset_at` INTEGER NOT NULL DEFAULT 0,
  `status` TEXT NOT NULL DEFAULT 'active',
  `created_at` TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX `idx_endpoints_user_slug` ON `endpoints` (`user_id`, `slug`);

CREATE TABLE `interactions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `endpoint_id` TEXT NOT NULL REFERENCES `endpoints`(`id`),
  `query` TEXT NOT NULL,
  `response` TEXT NOT NULL,
  `tokens_input` INTEGER,
  `tokens_output` INTEGER,
  `latency_ms` INTEGER,
  `confidence` TEXT,
  `confidence_sources` TEXT,
  `conversation_id` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX `idx_interactions_endpoint` ON `interactions` (`endpoint_id`, `created_at`);
CREATE INDEX `idx_interactions_conversation` ON `interactions` (`conversation_id`, `created_at`);
