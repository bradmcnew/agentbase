import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { endpoints } from '../db/schema'
import { generateSkillMd, generateLlmsTxt } from '../services/skill-gen'
import { handleQuery } from '../services/query-handler'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse } from '../utils/validate'
import { ENDPOINT_STATUS } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// --- Helper: load full endpoint row by ID ---

async function loadEndpointById(c: any, endpointId: string) {
  const db = c.get('db')
  const [ep] = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1)

  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) {
    return null
  }
  return ep
}

// --- Public routes (no auth, IP rate limited via CF Rate Limiting Rules) ---

// Public: Get endpoint's SKILL.md by globally unique endpoint ID
app.get('/v1/e/:endpointId/skill.md', async (c) => {
  const endpointId = c.req.param('endpointId')
  if (!endpointId) return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Endpoint ID is required')

  const db = c.get('db')

  const [endpoint] = await db
    .select({ skillMd: endpoints.skillMd, status: endpoints.status })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1)

  if (!endpoint || endpoint.status === ENDPOINT_STATUS.ARCHIVED) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  }

  if (!endpoint.skillMd) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md has not been generated yet')
  }

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(endpoint.skillMd)
})

// Public: Get endpoint's llms.txt by endpoint ID
app.get('/v1/e/:endpointId/llms.txt', async (c) => {
  const endpointId = c.req.param('endpointId')
  if (!endpointId) return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Endpoint ID is required')

  const db = c.get('db')

  const [endpoint] = await db
    .select({
      slug: endpoints.slug, name: endpoints.name, description: endpoints.description,
      capabilities: endpoints.capabilities, status: endpoints.status, id: endpoints.id,
    })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1)

  if (!endpoint || endpoint.status === ENDPOINT_STATUS.ARCHIVED) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  }

  const baseUrl = new URL(c.req.url).origin
  const llmsTxt = generateLlmsTxt({
    slug: endpoint.slug, name: endpoint.name, description: endpoint.description,
    capabilities: safeJsonParse(endpoint.capabilities, []),
    baseUrl, endpointId: endpoint.id,
  })

  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(llmsTxt)
})

// Public: Query endpoint by ID (no auth, daily quota via D1, IP rate limited via CF)
app.post('/v1/e/:endpointId/query', async (c) => {
  const endpointId = c.req.param('endpointId')
  if (!endpointId) return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Endpoint ID is required')

  const ep = await loadEndpointById(c, endpointId)
  if (!ep) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  }

  return handleQuery(c, ep)
})

// --- Authenticated routes ---

// Authenticated: Get endpoint SKILL.md by slug (scoped to account)
app.get('/v1/endpoints/:slug/skill.md', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')

  if (!ep.skillMd) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md has not been generated yet')
  }

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

// Regenerate SKILL.md (auth required)
app.post('/v1/endpoints/:slug/skill', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const db = c.get('db')

  const baseUrl = new URL(c.req.url).origin
  const skillMd = generateSkillMd({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id, mode: ep.mode,
  })

  await db.update(endpoints).set({ skillMd }).where(eq(endpoints.id, ep.id))

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  return c.text(skillMd)
})

export default app
