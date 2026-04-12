-- Drop Better Auth tables with wrong column names and recreate with correct snake_case columns
DROP TABLE IF EXISTS `session`;
DROP TABLE IF EXISTS `account`;
DROP TABLE IF EXISTS `verification`;
DROP TABLE IF EXISTS `user`;

CREATE TABLE `user` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `email` TEXT NOT NULL,
  `email_verified` INTEGER NOT NULL DEFAULT 0,
  `image` TEXT,
  `plan` TEXT DEFAULT 'free',
  `created_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  `updated_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);

CREATE TABLE `session` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `expires_at` INTEGER NOT NULL,
  `token` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  `updated_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  `ip_address` TEXT,
  `user_agent` TEXT,
  `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);

CREATE TABLE `account` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `account_id` TEXT NOT NULL,
  `provider_id` TEXT NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `access_token` TEXT,
  `refresh_token` TEXT,
  `id_token` TEXT,
  `access_token_expires_at` INTEGER,
  `refresh_token_expires_at` INTEGER,
  `scope` TEXT,
  `password` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  `updated_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);

CREATE TABLE `verification` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `identifier` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `expires_at` INTEGER NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  `updated_at` INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
