import { z } from 'zod'
import { DrizzleD1Database } from 'drizzle-orm/d1'
import type { EndpointRow } from './middleware/resolve-endpoint'

// --- Endpoint constants ---

export const ENDPOINT_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const

export const ENDPOINT_MODE = {
  PLATFORM: 'platform',
  BYOK: 'byok',
  EXTERNAL: 'external',
} as const

export const PLATFORM_MODELS = ['gpt-5-mini', 'gpt-5-nano'] as const

export type EndpointStatus = typeof ENDPOINT_STATUS[keyof typeof ENDPOINT_STATUS]
export type EndpointMode = typeof ENDPOINT_MODE[keyof typeof ENDPOINT_MODE]

// --- Request schemas ---

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(200),
})

export const CreateEndpointSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string()).default([]),
  system_prompt: z.string().max(5000).optional(),
  // Mode configuration
  mode: z.enum([ENDPOINT_MODE.PLATFORM, ENDPOINT_MODE.BYOK, ENDPOINT_MODE.EXTERNAL]).default(ENDPOINT_MODE.PLATFORM),
  webhook_url: z.string().url().optional(),
  llm_provider: z.enum(['openai', 'anthropic']).optional(),
  llm_api_key: z.string().optional(),
  llm_model: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.mode === ENDPOINT_MODE.EXTERNAL && !data.webhook_url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'webhook_url is required for external mode', path: ['webhook_url'] })
  }
  if (data.mode === ENDPOINT_MODE.EXTERNAL && data.webhook_url && !data.webhook_url.startsWith('https://')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'webhook_url must use HTTPS', path: ['webhook_url'] })
  }
  if (data.mode === ENDPOINT_MODE.BYOK && !data.llm_provider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'llm_provider is required for byok mode', path: ['llm_provider'] })
  }
  if (data.mode === ENDPOINT_MODE.BYOK && !data.llm_api_key) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'llm_api_key is required for byok mode', path: ['llm_api_key'] })
  }
})

export const UpdateEndpointSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string()).optional(),
  system_prompt: z.string().max(5000).optional(),
  status: z.enum([ENDPOINT_STATUS.ACTIVE, ENDPOINT_STATUS.PAUSED]).optional(),
  llm_model: z.string().optional(),
  webhook_url: z.string().url().optional(),
  llm_api_key: z.string().optional(),
})

export const UploadDocumentSchema = z.object({
  content: z.string().min(1),
  filename: z.string().min(1).max(255),
})

export const QueryEndpointSchema = z.object({
  query: z.string().min(1).max(5000),
  context: z.string().max(2000).optional(),
  max_sources: z.number().int().min(1).max(10).default(3),
})

// --- Env bindings ---

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  AZURE_SEARCH_ENDPOINT: string
  AZURE_SEARCH_API_KEY: string
  AZURE_OPENAI_ENDPOINT: string
  AZURE_OPENAI_API_KEY: string
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: string
  AZURE_OPENAI_CHAT_DEPLOYMENT: string
  ENCRYPTION_SECRET: string  // For encrypting BYOK API keys at rest
  UNKEY_ROOT_KEY: string
  UNKEY_API_ID: string
}

// --- Auth context ---

export interface AuthContext {
  accountId: string
  apiKeyId: string
}

// --- Hono app type with all variables ---

export interface AppVariables {
  auth: AuthContext
  db: DrizzleD1Database
  endpoint: EndpointRow
}
