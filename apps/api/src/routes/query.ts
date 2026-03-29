import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { interactions } from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { parseIntParam } from '../utils/validate'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// List interactions
app.get('/v1/endpoints/:slug/interactions', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
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
