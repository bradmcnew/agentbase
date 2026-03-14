import { Hono } from 'hono'
import { eq, and, ne, sql } from 'drizzle-orm'
import { endpoints } from '../db/schema'
import { generateId } from '../utils/id'
import { AzureSearchClient, createSearchClient } from '../services/azure-search'
import { generateSkillMd } from '../services/skill-gen'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { encrypt } from '../utils/encrypt'
import { parseBody, safeJsonParse } from '../utils/validate'
import { CreateEndpointSchema, UpdateEndpointSchema, ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('*', authMiddleware)

// Create endpoint (no resolveEndpoint — endpoint doesn't exist yet)
app.post('/v1/endpoints', async (c) => {
  const data = await parseBody(c, CreateEndpointSchema)
  if (data instanceof Response) return data

  const auth = c.get('auth')
  const db = c.get('db')

  // Check endpoint limit
  const [{ count: endpointCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(endpoints)
    .where(and(eq(endpoints.accountId, auth.accountId), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))

  if (endpointCount >= PLAN_LIMITS.free.maxEndpoints) {
    return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED,
      `Endpoint limit reached (${PLAN_LIMITS.free.maxEndpoints} active endpoints). Archive unused endpoints or upgrade.`)
  }

  const [existing] = await db
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(and(eq(endpoints.accountId, auth.accountId), eq(endpoints.slug, data.slug)))
    .limit(1)

  if (existing) {
    return errorResponse(c, 409, ErrorCode.CONFLICT, `Endpoint with slug "${data.slug}" already exists`)
  }

  const endpointId = generateId()
  const baseUrl = new URL(c.req.url).origin
  const mode = data.mode || ENDPOINT_MODE.PLATFORM

  // Generate webhook signing secret for external endpoints
  let webhookSecret: string | null = null
  if (mode === ENDPOINT_MODE.EXTERNAL) {
    webhookSecret = `whsec_${generateId()}`
  }

  // Create Azure Search index for platform and byok modes (not external)
  let azureIndexName: string | null = null
  if (mode !== ENDPOINT_MODE.EXTERNAL) {
    const search = createSearchClient(c.env)
    azureIndexName = AzureSearchClient.indexName(auth.accountId, data.slug)
    try {
      await search.createIndex(azureIndexName)
    } catch (err) {
      return serviceError(c, ErrorCode.SEARCH_ERROR, 'Failed to create search index. Please try again.', err)
    }
  }

  const skillMd = generateSkillMd({
    slug: data.slug, name: data.name, description: data.description,
    capabilities: data.capabilities ?? [], baseUrl, endpointId, mode,
  })

  await db.insert(endpoints).values({
    id: endpointId, accountId: auth.accountId, slug: data.slug,
    name: data.name, description: data.description || null,
    azureIndexName: azureIndexName || '',  // empty string for external (column is NOT NULL in original migration)
    mode,
    webhookUrl: data.webhook_url || null,
    llmProvider: data.llm_provider || null,
    llmApiKey: data.llm_api_key ? await encrypt(data.llm_api_key, c.env.ENCRYPTION_SECRET) : null,
    llmModel: data.llm_model || null,
    webhookSecret,
    capabilities: JSON.stringify(data.capabilities ?? []),
    systemPrompt: data.system_prompt || null, skillMd,
  })

  return c.json({
    endpoint: {
      id: endpointId, slug: data.slug, name: data.name,
      description: data.description || null,
      capabilities: data.capabilities ?? [],
      mode,
      status: ENDPOINT_STATUS.ACTIVE,
      skill_md_url: `${baseUrl}/v1/e/${endpointId}/skill.md`,
      created_at: new Date().toISOString(),
      ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
    },
  }, 201)
})

// List endpoints
app.get('/v1/endpoints', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')

  const results = await db
    .select({
      id: endpoints.id, slug: endpoints.slug, name: endpoints.name,
      description: endpoints.description, status: endpoints.status, createdAt: endpoints.createdAt,
    })
    .from(endpoints)
    .where(eq(endpoints.accountId, auth.accountId))

  return c.json({ endpoints: results })
})

// --- Routes below use resolveEndpoint middleware ---

// Get endpoint
app.get('/v1/endpoints/:slug', resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  return c.json({
    endpoint: {
      id: ep.id, slug: ep.slug, name: ep.name, description: ep.description,
      capabilities: safeJsonParse(ep.capabilities, []),
      mode: ep.mode, llm_model: ep.llmModel,
      status: ep.status, created_at: ep.createdAt,
    },
  })
})

// Update endpoint
app.patch('/v1/endpoints/:slug', resolveEndpoint as any, async (c) => {
  const data = await parseBody(c, UpdateEndpointSchema)
  if (data instanceof Response) return data

  const ep = c.get('endpoint')
  const db = c.get('db')

  const updates: Record<string, unknown> = {}
  if (data.name !== undefined) updates.name = data.name
  if (data.description !== undefined) updates.description = data.description
  if (data.capabilities !== undefined) updates.capabilities = JSON.stringify(data.capabilities)
  if (data.system_prompt !== undefined) updates.systemPrompt = data.system_prompt
  if (data.status !== undefined) updates.status = data.status
  if (data.llm_model !== undefined) updates.llmModel = data.llm_model
  if (data.webhook_url !== undefined) updates.webhookUrl = data.webhook_url
  if (data.llm_api_key !== undefined) updates.llmApiKey = data.llm_api_key ? await encrypt(data.llm_api_key, c.env.ENCRYPTION_SECRET) : null

  if (Object.keys(updates).length > 0) {
    await db.update(endpoints).set(updates).where(eq(endpoints.id, ep.id))
  }

  return c.json({ success: true })
})

// Delete endpoint (soft-delete + Azure index cleanup)
app.delete('/v1/endpoints/:slug', resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const db = c.get('db')
  const search = createSearchClient(c.env)

  await db.update(endpoints).set({ status: ENDPOINT_STATUS.ARCHIVED }).where(eq(endpoints.id, ep.id))

  // Clean up Azure Search index if it exists (not for external mode)
  if (ep.azureIndexName) {
    c.executionCtx.waitUntil(
      search.deleteIndex(ep.azureIndexName).catch(err => {
        console.error('Failed to delete Azure index:', ep.azureIndexName, err)
      })
    )
  }

  return c.json({ success: true })
})

export default app
