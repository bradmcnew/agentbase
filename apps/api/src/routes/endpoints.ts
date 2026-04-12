import { Hono } from 'hono'
import { eq, and, ne, sql } from 'drizzle-orm'
import { user, endpoints, interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { generateSkillMd } from '../services/skill-gen'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, ErrorCode } from '../utils/errors'
import { encrypt } from '../utils/encrypt'
import { parseBody, safeJsonParse } from '../utils/validate'
import { createCustomHostname, deleteCustomHostname, CNAME_TARGET } from '../services/custom-domains'
import { CreateEndpointSchema, UpdateEndpointSchema, ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('*', authMiddleware)

// Create endpoint
app.post('/v1/endpoints', async (c) => {
  const data = await parseBody(c, CreateEndpointSchema)
  if (data instanceof Response) return data

  const auth = c.get('auth')
  const db = c.get('db')

  // Check endpoint limit based on user plan
  const [u] = await db.select({ plan: user.plan }).from(user).where(eq(user.id, auth.userId)).limit(1)
  const plan = (u?.plan === 'pro' ? 'pro' : 'free') as keyof typeof PLAN_LIMITS
  const maxEndpoints = PLAN_LIMITS[plan].maxEndpoints

  const [{ count: endpointCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(endpoints)
    .where(and(eq(endpoints.userId, auth.userId), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))

  if (endpointCount >= maxEndpoints) {
    return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED,
      `Endpoint limit reached (${maxEndpoints} active endpoints). Archive unused endpoints or upgrade.`)
  }

  // Slugs must be globally unique among active endpoints
  const [existing] = await db
    .select({ id: endpoints.id, status: endpoints.status })
    .from(endpoints)
    .where(eq(endpoints.slug, data.slug))
    .limit(1)

  if (existing) {
    if (existing.status !== ENDPOINT_STATUS.ARCHIVED) {
      return errorResponse(c, 409, ErrorCode.CONFLICT, `Slug "${data.slug}" is already taken. Choose a different slug.`)
    }
    await db.delete(interactions).where(eq(interactions.endpointId, existing.id))
    await db.delete(endpoints).where(eq(endpoints.id, existing.id))
  }

  const endpointId = generateId()
  const baseUrl = new URL(c.req.url).origin
  const mode = ENDPOINT_MODE.EXTERNAL

  // Generate webhook signing secret
  const webhookSecret = `whsec_${generateId()}`

  const skillMd = generateSkillMd({
    slug: data.slug, name: data.name, description: data.description,
    capabilities: data.capabilities ?? [], baseUrl, endpointId,
    customDomain: data.custom_domain,
  })

  await db.insert(endpoints).values({
    id: endpointId, userId: auth.userId, slug: data.slug,
    name: data.name, description: data.description || null,
    mode,
    webhookUrl: data.webhook_url,
    webhookSecret: await encrypt(webhookSecret, c.env.ENCRYPTION_SECRET),
    externalModel: data.external_model || null,
    externalApiKey: data.external_api_key ? await encrypt(data.external_api_key, c.env.ENCRYPTION_SECRET) : null,
    capabilities: JSON.stringify(data.capabilities ?? []),
    systemPrompt: data.system_prompt || null, skillMd,
    customDomain: data.custom_domain || null,
  })

  // Provision custom hostname with Cloudflare for SaaS
  if (data.custom_domain) {
    try {
      await createCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, data.custom_domain)
    } catch (err) {
      console.error('Custom hostname creation failed:', err)
    }
  }

  return c.json({
    endpoint: {
      id: endpointId, slug: data.slug, name: data.name,
      description: data.description || null,
      capabilities: data.capabilities ?? [],
      mode,
      status: ENDPOINT_STATUS.ACTIVE,
      skill_md_url: data.custom_domain
        ? `https://${data.custom_domain}/skill.md`
        : `${baseUrl}/v1/e/${endpointId}/skill.md`,
      created_at: new Date().toISOString(),
      webhook_secret: webhookSecret,
      ...(data.custom_domain ? {
        custom_domain: data.custom_domain,
        cname_target: CNAME_TARGET,
        dns_status: 'pending',
        dns_instructions: `Add a CNAME record: ${data.custom_domain} → ${CNAME_TARGET}`,
      } : {}),
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
    .where(eq(endpoints.userId, auth.userId))

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
      mode: ep.mode,
      custom_domain: ep.customDomain || null,
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
  if (data.webhook_url !== undefined) updates.webhookUrl = data.webhook_url
  if (data.external_model !== undefined) updates.externalModel = data.external_model
  if (data.external_api_key !== undefined) updates.externalApiKey = data.external_api_key ? await encrypt(data.external_api_key, c.env.ENCRYPTION_SECRET) : null

  // Handle custom domain changes
  if (data.custom_domain !== undefined) {
    const newDomain = data.custom_domain

    if (ep.customDomain && ep.customDomain !== newDomain) {
      c.executionCtx.waitUntil(
        deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, ep.customDomain).catch(err =>
          console.error('Failed to delete old custom hostname:', err)
        )
      )
    }

    if (newDomain && newDomain !== ep.customDomain) {
      try {
        await createCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, newDomain)
      } catch (err) {
        console.error('Custom hostname creation failed:', err)
      }
    }

    updates.customDomain = newDomain
  }

  // Regenerate SKILL.md if any displayed fields changed
  if (data.name !== undefined || data.description !== undefined || data.capabilities !== undefined || data.custom_domain !== undefined) {
    const baseUrl = new URL(c.req.url).origin
    updates.skillMd = generateSkillMd({
      slug: ep.slug, name: (updates.name as string) ?? ep.name,
      description: (updates.description as string | undefined) ?? ep.description,
      capabilities: data.capabilities ?? safeJsonParse(ep.capabilities, []),
      baseUrl, endpointId: ep.id,
      customDomain: (updates.customDomain as string | undefined) ?? ep.customDomain,
    })
  }

  if (Object.keys(updates).length > 0) {
    await db.update(endpoints).set(updates).where(eq(endpoints.id, ep.id))
  }

  const response: Record<string, unknown> = { success: true }
  if (data.custom_domain) {
    response.custom_domain = data.custom_domain
    response.cname_target = CNAME_TARGET
    response.dns_status = 'pending'
    response.dns_instructions = `Add a CNAME record: ${data.custom_domain} → ${CNAME_TARGET}`
  }

  return c.json(response)
})

// Delete endpoint (soft-delete)
app.delete('/v1/endpoints/:slug', resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const db = c.get('db')

  await db.update(endpoints).set({ status: ENDPOINT_STATUS.ARCHIVED, customDomain: null }).where(eq(endpoints.id, ep.id))

  if (ep.customDomain) {
    c.executionCtx.waitUntil(
      deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, ep.customDomain).catch(err => {
        console.error('Failed to delete custom hostname:', ep.customDomain, err)
      })
    )
  }

  return c.json({ success: true })
})

export default app
