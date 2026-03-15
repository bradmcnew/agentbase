import { Context, Next } from 'hono'
import { Unkey } from '@unkey/api'
import { errorResponse, ErrorCode } from '../utils/errors'
import type { Env, AppVariables } from '../types'

// Cached per Worker isolate
let unkeyClient: Unkey | null = null

/** Cached Unkey client for key management (used by accounts.ts for key creation) */
export function getUnkeyClient(rootKey: string): Unkey {
  if (!unkeyClient) unkeyClient = new Unkey({ rootKey })
  return unkeyClient
}

/** Extract Bearer token from Authorization header */
function extractKey(c: Context): string | Response {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED,
      'Missing or invalid Authorization header. Use: Bearer {api_key}')
  }
  const key = authHeader.slice(7)
  if (!key) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Missing API key')
  }
  return key
}

/** Map Unkey verify response to our auth context. Returns error Response or null on success. */
function setAuthContext(c: Context<{ Bindings: Env; Variables: AppVariables }>, data: any): Response | null {
  const accountId = data.identity?.externalId
  if (!accountId) {
    console.error('Unkey key missing identity.externalId:', data.keyId)
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid API key configuration')
  }
  c.set('auth', { accountId, apiKeyId: data.keyId! })
  return null
}

/**
 * Auth middleware: verifies Bearer token via @unkey/api.
 * Does NOT deduct credits. Allows USAGE_EXCEEDED through (key is valid,
 * just out of query credits -- non-query routes should still work).
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const key = extractKey(c)
  if (key instanceof Response) return key

  try {
    const client = getUnkeyClient(c.env.UNKEY_ROOT_KEY)
    const response = await client.keys.verifyKey({ key })
    const data = response.data

    if (!data.valid) {
      // USAGE_EXCEEDED means key is real but out of credits -- still allow non-query routes
      if (data.code === 'USAGE_EXCEEDED') {
        const err = setAuthContext(c, data)
        if (err) return err
        await next()
        return
      }
      if (data.code === 'RATE_LIMITED') {
        c.header('Retry-After', '60')
        return errorResponse(c, 429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.')
      }
      return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid or revoked API key')
    }

    const err = setAuthContext(c, data)
    if (err) return err
    await next()
  } catch (err) {
    console.error('Unkey verification error:', err)
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, 'Authentication service error')
  }
}
