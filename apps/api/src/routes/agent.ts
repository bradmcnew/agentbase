import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { endpoints } from '../db/schema'
import { handleQuery } from '../services/query-handler'
import { generateLlmsTxt } from '../services/skill-gen'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse } from '../utils/validate'
import { ENDPOINT_STATUS } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

async function resolveBySlug(c: any) {
  const slug = c.req.param('slug')
  if (!slug) return null
  const db = c.get('db')
  const [ep] = await db.select().from(endpoints).where(eq(endpoints.slug, slug)).limit(1)
  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) return null
  return ep
}

app.get('/a/:slug/skill.md', async (c) => {
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  if (!ep.skillMd) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md not generated yet')
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.get('/a/:slug/llms.txt', async (c) => {
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  const baseUrl = new URL(c.req.url).origin
  const llmsTxt = generateLlmsTxt({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id,
  })
  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(llmsTxt)
})

app.post('/a/:slug/query', async (c) => {
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  return handleQuery(c, ep)
})

export default app
