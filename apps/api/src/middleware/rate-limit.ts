import { Context, Next } from 'hono'
import { errorResponse, ErrorCode } from '../utils/errors'

/**
 * Best-effort in-memory rate limiter for Cloudflare Workers.
 *
 * IMPORTANT: On Workers, each isolate has its own Map. Under load, requests
 * may hit different isolates, making this rate limiter approximate, not exact.
 * For strict rate limiting, use Cloudflare Rate Limiting rules or Durable Objects.
 *
 * Includes periodic cleanup of expired entries to prevent memory leaks.
 */
const windows = new Map<string, { count: number; resetAt: number }>()
let lastCleanup = Date.now()

function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < 60_000) return // Clean up at most once per minute
  lastCleanup = now
  for (const [key, window] of windows) {
    if (now > window.resetAt) windows.delete(key)
  }
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    cleanup()

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
    const key = `${c.req.path}:${ip}`
    const now = Date.now()

    let window = windows.get(key)
    if (!window || now > window.resetAt) {
      window = { count: 0, resetAt: now + windowMs }
      windows.set(key, window)
    }

    window.count++

    if (window.count > maxRequests) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000)
      c.header('Retry-After', String(retryAfter))
      return errorResponse(c, 429, ErrorCode.RATE_LIMITED, `Too many requests. Try again in ${retryAfter} seconds.`)
    }

    await next()
  }
}
