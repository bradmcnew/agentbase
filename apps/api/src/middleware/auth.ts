import { Context, Next, MiddlewareHandler } from 'hono'
import { unkey as createUnkeyMiddleware, type UnkeyContext } from '@unkey/hono'
import { Unkey } from '@unkey/api'
import { errorResponse, ErrorCode } from '../utils/errors'
import type { Env, AppVariables } from '../types'

// Cached per Worker isolate — initialized on first request when c.env is available
let verifyMiddleware: MiddlewareHandler | null = null
let unkeyClient: Unkey | null = null

/** Cached Unkey client for key management (used by accounts.ts for key creation) */
export function getUnkeyClient(rootKey: string): Unkey {
  if (!unkeyClient) unkeyClient = new Unkey({ rootKey })
  return unkeyClient
}

function getVerifyMiddleware(rootKey: string): MiddlewareHandler {
  if (!verifyMiddleware) {
    verifyMiddleware = createUnkeyMiddleware({
      rootKey,
      getKey: (c) => {
        const auth = c.req.header('Authorization')
        if (!auth?.startsWith('Bearer ')) {
          return errorResponse(c, 401, ErrorCode.UNAUTHORIZED,
            'Missing or invalid Authorization header. Use: Bearer {api_key}')
        }
        const key = auth.slice(7)
        if (!key) {
          return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Missing API key')
        }
        return key
      },
      handleInvalidKey: (c, result) => {
        if (result.data.code === 'RATE_LIMITED') {
          c.header('Retry-After', '60')
          return errorResponse(c, 429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.')
        }
        if (result.data.code === 'USAGE_EXCEEDED') {
          return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED, 'Daily query limit reached. Resets at midnight UTC.')
        }
        return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid or revoked API key')
      },
      onError: (c, err) => {
        console.error('Unkey verification error:', err)
        return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, 'Authentication service error')
      },
    })
  }
  return verifyMiddleware
}

/**
 * Auth middleware: verifies Bearer token via @unkey/hono, then maps
 * Unkey's identity to our auth context (accountId + apiKeyId).
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const verify = getVerifyMiddleware(c.env.UNKEY_ROOT_KEY)

  // Run @unkey/hono verification. On error it returns a Response without calling fakeNext.
  let verified = false
  const maybeError = await verify(c, async () => { verified = true })
  if (!verified) return maybeError

  // Map Unkey context → our auth context
  const result = (c.get as any)('unkey') as UnkeyContext
  const accountId = result.data.identity?.externalId
  if (!accountId) {
    console.error('Unkey key missing identity.externalId:', result.data.keyId)
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid API key configuration')
  }

  c.set('auth', { accountId, apiKeyId: result.data.keyId! })
  await next()
}

/**
 * Auth middleware with credit deduction: verifies Bearer token via @unkey/api
 * directly (not @unkey/hono) so we can pass credits cost. Each call auto-deducts
 * 1 credit. Used only on the query route.
 */
export async function authWithCredits(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED,
      'Missing or invalid Authorization header. Use: Bearer {api_key}')
  }

  const key = authHeader.slice(7)
  if (!key) {
    return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Missing API key')
  }

  try {
    const client = getUnkeyClient(c.env.UNKEY_ROOT_KEY)
    const response = await client.keys.verifyKey({ key, credits: { cost: 1 } })
    const data = response.data

    if (!data.valid) {
      if (data.code === 'USAGE_EXCEEDED') {
        return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED,
          'Daily query limit reached. Resets at midnight UTC.')
      }
      if (data.code === 'RATE_LIMITED') {
        c.header('Retry-After', '60')
        return errorResponse(c, 429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.')
      }
      return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid or revoked API key')
    }

    const accountId = data.identity?.externalId
    if (!accountId) {
      console.error('Unkey key missing identity.externalId:', data.keyId)
      return errorResponse(c, 401, ErrorCode.UNAUTHORIZED, 'Invalid API key configuration')
    }

    c.set('auth', { accountId, apiKeyId: data.keyId! })
    if (data.credits !== undefined) {
      c.set('remainingCredits', data.credits)
    }
    await next()
  } catch (err) {
    console.error('Unkey verification error:', err)
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, 'Authentication service error')
  }
}
