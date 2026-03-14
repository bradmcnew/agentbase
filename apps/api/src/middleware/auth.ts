import { Context, Next } from 'hono'
import { eq, isNull, and } from 'drizzle-orm'
import { apiKeys } from '../db/schema'
import { hashKey } from '../services/api-keys'
import { errorResponse, ErrorCode } from '../utils/errors'
import type { Env, AppVariables } from '../types'

/**
 * Auth middleware: extracts Bearer token, validates against D1.
 * Requires dbMiddleware to have run first.
 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: AppVariables }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header. Use: Bearer {api_key}')
  }

  const rawKey = authHeader.slice(7)
  if (!rawKey.startsWith('ap_sk_')) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid API key format')
  }

  const keyHash = await hashKey(rawKey)
  const db = c.get('db')

  const [key] = await db
    .select({ id: apiKeys.id, accountId: apiKeys.accountId, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1)

  if (!key) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid or revoked API key')
  }

  // Throttle last_used_at writes — only update if >5 minutes stale
  const now = new Date()
  const lastUsed = key.lastUsedAt ? new Date(key.lastUsedAt) : null
  if (!lastUsed || now.getTime() - lastUsed.getTime() > 5 * 60 * 1000) {
    c.executionCtx.waitUntil(
      db.update(apiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(apiKeys.id, key.id))
    )
  }

  c.set('auth', { accountId: key.accountId, apiKeyId: key.id })
  await next()
}
