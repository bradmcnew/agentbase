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
  EXTERNAL: 'external',
} as const

// --- Plan limits ---

export const PLAN_LIMITS = {
  free: { queriesPerDay: 1000, maxEndpoints: 1 },
  pro: { queriesPerDay: 10_000, maxEndpoints: 50 },
} as const

export type EndpointStatus = typeof ENDPOINT_STATUS[keyof typeof ENDPOINT_STATUS]
export type EndpointMode = typeof ENDPOINT_MODE[keyof typeof ENDPOINT_MODE]

// --- Domain blocklist ---

const BLOCKED_DOMAIN_SUFFIXES = ['.axite.ai', '.workers.dev', '.cloudflare.com', '.cloudflaressl.com', '.pages.dev', '.r2.dev']
const isBlockedDomain = (d: string) => BLOCKED_DOMAIN_SUFFIXES.some(s => d === s.slice(1) || d.endsWith(s))

const customDomainBase = z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'Must be a valid hostname')

// --- Request schemas ---

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(200),
})

export const CreateEndpointSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().max(200)).max(50).default([]),
  system_prompt: z.string().max(5000).optional(),
  webhook_url: z.string().url(),
  external_model: z.string().max(100).optional(),
  external_api_key: z.string().max(500).optional(),
  custom_domain: customDomainBase.refine(d => !isBlockedDomain(d), { message: 'This domain is reserved' }).optional(),
}).refine(data => data.webhook_url.startsWith('https://'), { message: 'webhook_url must use HTTPS', path: ['webhook_url'] })

export const UpdateEndpointSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().max(200)).max(50).optional(),
  system_prompt: z.string().max(5000).optional(),
  status: z.enum([ENDPOINT_STATUS.ACTIVE, ENDPOINT_STATUS.PAUSED]).optional(),
  webhook_url: z.string().url().refine(u => u.startsWith('https://'), { message: 'webhook_url must use HTTPS' }).optional(),
  external_model: z.string().max(100).optional(),
  external_api_key: z.string().max(500).optional(),
  custom_domain: customDomainBase.refine(d => !isBlockedDomain(d), { message: 'This domain is reserved' }).nullable().optional(),
})

export const QueryEndpointSchema = z.object({
  query: z.string().min(1).max(5000),
  context: z.string().max(2000).optional(),
  conversation_id: z.string().max(100).optional(),
})

// --- Env bindings ---

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  ENCRYPTION_SECRET: string
  UNKEY_ROOT_KEY: string
  UNKEY_API_ID: string
  CF_ZONE_ID: string
  CF_API_TOKEN: string
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
