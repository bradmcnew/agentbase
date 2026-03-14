import { Hono } from 'hono'
import { accounts } from '../db/schema'
import { getUnkeyClient } from '../middleware/auth'
import { generateId } from '../utils/id'
import { parseBody } from '../utils/validate'
import { errorResponse, ErrorCode } from '../utils/errors'
import { CreateAccountSchema } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// In-memory IP rate limit for account creation (no API key yet)
const windows = new Map<string, { count: number; resetAt: number }>()
let lastCleanup = Date.now()

function ipRateLimit(ip: string, maxRequests: number, windowMs: number): number | null {
  const now = Date.now()
  if (now - lastCleanup > 60_000) {
    lastCleanup = now
    for (const [key, window] of windows) {
      if (now > window.resetAt) windows.delete(key)
    }
  }

  let window = windows.get(ip)
  if (!window || now > window.resetAt) {
    window = { count: 0, resetAt: now + windowMs }
    windows.set(ip, window)
  }

  window.count++
  if (window.count > maxRequests) {
    return Math.ceil((window.resetAt - now) / 1000)
  }
  return null
}

app.post('/v1/accounts', async (c) => {
  // IP-based rate limit: 5 per hour
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
  const retryAfter = ipRateLimit(ip, 5, 60 * 60 * 1000)
  if (retryAfter !== null) {
    c.header('Retry-After', String(retryAfter))
    return errorResponse(c, 429, ErrorCode.RATE_LIMITED, `Too many requests. Try again in ${retryAfter} seconds.`)
  }

  const data = await parseBody(c, CreateAccountSchema)
  if (data instanceof Response) return data

  const db = c.get('db')
  const accountId = generateId()

  // Create Unkey key first — if this fails, no orphaned account row in D1
  try {
    const unkey = getUnkeyClient(c.env.UNKEY_ROOT_KEY)
    const response = await unkey.keys.createKey({
      apiId: c.env.UNKEY_API_ID,
      externalId: accountId,
      name: `${data.name} default key`,
      meta: { plan: 'free' },
      ratelimits: [{ name: 'api_requests', limit: 60, duration: 60_000 }],
    })

    await db.insert(accounts).values({ id: accountId, name: data.name, createdBy: 'agent' })

    return c.json({
      account: { id: accountId, name: data.name, plan: 'free', created_at: new Date().toISOString() },
      api_key: response.data.key,
    }, 201)
  } catch (err) {
    console.error('Unkey key creation error:', err)
    return errorResponse(c, 500, ErrorCode.INTERNAL_ERROR, 'Failed to create API key')
  }
})

export default app
