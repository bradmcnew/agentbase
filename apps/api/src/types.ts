import { z } from 'zod'
import { DrizzleD1Database } from 'drizzle-orm/d1'
import type { EndpointRow } from './middleware/resolve-endpoint'

// --- Endpoint status ---

export const ENDPOINT_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const

export type EndpointStatus = typeof ENDPOINT_STATUS[keyof typeof ENDPOINT_STATUS]

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
})

export const UpdateEndpointSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string()).optional(),
  system_prompt: z.string().max(5000).optional(),
  status: z.enum([ENDPOINT_STATUS.ACTIVE, ENDPOINT_STATUS.PAUSED]).optional(),
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
