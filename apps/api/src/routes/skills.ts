import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { endpoints } from '../db/schema'
import { generateSkillMd } from '../services/skill-gen'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse } from '../utils/validate'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.get('/v1/endpoints/:slug/skill.md', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')

  if (!ep.skillMd) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md has not been generated yet')
  }

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.post('/v1/endpoints/:slug/skill', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const db = c.get('db')

  const baseUrl = new URL(c.req.url).origin
  const skillMd = generateSkillMd({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id, mode: ep.mode,
    customDomain: ep.customDomain,
  })

  await db.update(endpoints).set({ skillMd }).where(eq(endpoints.id, ep.id))

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  return c.text(skillMd)
})

export default app
