import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  createdBy: text('created_by').notNull().default('agent'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  plan: text('plan').notNull().default('free'),
})

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  name: text('name').notNull().default('default'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('idx_api_keys_account').on(table.accountId),
])

export const endpoints = sqliteTable('endpoints', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  azureIndexName: text('azure_index_name'),  // null for external mode
  mode: text('mode').notNull().default('platform'),  // platform | byok | external
  webhookUrl: text('webhook_url'),            // external mode
  llmProvider: text('llm_provider'),          // byok mode: openai | anthropic
  llmApiKey: text('llm_api_key'),             // byok mode: customer's key
  llmModel: text('llm_model'),               // platform/byok: model name
  capabilities: text('capabilities').notNull().default('[]'),
  systemPrompt: text('system_prompt'),
  skillMd: text('skill_md'),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_endpoints_account_slug').on(table.accountId, table.slug),
])

export const interactions = sqliteTable('interactions', {
  id: text('id').primaryKey(),
  endpointId: text('endpoint_id').notNull().references(() => endpoints.id),
  query: text('query').notNull(),
  response: text('response').notNull(),
  sources: text('sources'),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  latencyMs: integer('latency_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_interactions_endpoint').on(table.endpointId, table.createdAt),
])
