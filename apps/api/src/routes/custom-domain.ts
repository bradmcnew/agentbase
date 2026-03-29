/**
 * Custom domain routing: when a request arrives on a customer's domain
 * (e.g., docs.acme.com), route it to the right endpoint.
 *
 * Simplified URL structure on custom domains:
 *   GET  /skill.md        → endpoint's SKILL.md
 *   GET  /llms.txt        → endpoint's llms.txt
 *   POST /query           → query the endpoint (public, IP rate limited)
 *   GET  /interactions    → list interactions
 */

import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { endpoints, interactions } from '../db/schema'
import { handleQuery } from '../services/query-handler'
import { generateLlmsTxt } from '../services/skill-gen'
import { authMiddleware } from '../middleware/auth'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse, parseIntParam } from '../utils/validate'
import { ENDPOINT_STATUS } from '../types'
import type { Env, AppVariables } from '../types'
import type { EndpointRow } from '../middleware/resolve-endpoint'

const PLATFORM_HOSTNAME = 'agentbase.to'

const app = new Hono<{ Bindings: Env; Variables: AppVariables & { customEndpoint: EndpointRow } }>()

/**
 * Middleware: resolve endpoint by hostname.
 * Only runs for non-platform hostnames.
 */
async function resolveByHostname(c: any, next: any) {
  const hostname = new URL(c.req.url).hostname
  if (hostname === PLATFORM_HOSTNAME || hostname.endsWith('.workers.dev')) {
    return // Platform request -- skip, let standard routes handle it
  }

  const db = c.get('db')
  const [ep] = await db.select().from(endpoints).where(eq(endpoints.customDomain, hostname)).limit(1)

  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'No endpoint configured for this domain')
  }

  c.set('endpoint', ep)
  await next()
}

// --- Public routes (no auth) ---

app.get('/skill.md', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return // Not a custom domain
  if (!ep.skillMd) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md not generated yet')

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.get('/llms.txt', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  const hostname = new URL(c.req.url).hostname
  const baseUrl = `https://${hostname}`
  const llmsTxt = generateLlmsTxt({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id,
  })

  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(llmsTxt)
})

// Public: Query via custom domain (no auth, daily quota via D1, IP rate limited via CF)
app.post('/query', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  return handleQuery(c, ep)
})

// --- Authenticated routes ---

/** Verify the authenticated account owns the endpoint resolved by hostname */
async function verifyOwnership(c: any, next: any) {
  const ep = c.get('endpoint')
  const auth = c.get('auth')
  if (!ep || !auth) return
  if (ep.accountId !== auth.accountId) {
    return errorResponse(c, 403, ErrorCode.UNAUTHORIZED, 'Not authorized for this endpoint')
  }
  return next()
}

app.get('/interactions', resolveByHostname, authMiddleware, verifyOwnership, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  const db = c.get('db')
  const limit = parseIntParam(c.req.query('limit'), 50, 1, 100)
  const offset = parseIntParam(c.req.query('offset'), 0, 0)

  const results = await db
    .select({
      id: interactions.id, query: interactions.query, response: interactions.response,
      tokensInput: interactions.tokensInput,
      tokensOutput: interactions.tokensOutput, latencyMs: interactions.latencyMs,
      confidence: interactions.confidence, confidenceSources: interactions.confidenceSources,
      createdAt: interactions.createdAt,
    })
    .from(interactions)
    .where(eq(interactions.endpointId, ep.id))
    .orderBy(desc(interactions.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({ interactions: results })
})

export default app
