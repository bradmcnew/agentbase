import { eq, and, ne, sql } from 'drizzle-orm'
import { DrizzleD1Database } from 'drizzle-orm/d1'
import { endpoints } from '../db/schema'
import { ENDPOINT_STATUS, PLAN_LIMITS } from '../types'

/** Find an active endpoint by userId + slug, selecting only needed columns. */
export async function findEndpointLite(db: DrizzleD1Database, userId: string, slug: string) {
  const [ep] = await db
    .select({
      id: endpoints.id, slug: endpoints.slug, name: endpoints.name,
      description: endpoints.description, status: endpoints.status,
      webhookUrl: endpoints.webhookUrl, capabilities: endpoints.capabilities,
      systemPrompt: endpoints.systemPrompt, customDomain: endpoints.customDomain,
      externalModel: endpoints.externalModel,
      queryCount: endpoints.queryCount, createdAt: endpoints.createdAt,
    })
    .from(endpoints)
    .where(and(eq(endpoints.userId, userId), eq(endpoints.slug, slug), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))
    .limit(1)
  return ep ?? null
}

/** Check if user has reached their plan's endpoint limit. Returns { count, limit, exceeded }. */
export async function checkEndpointLimit(db: DrizzleD1Database, userId: string, plan: string) {
  const limit = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]?.maxEndpoints ?? PLAN_LIMITS.free.maxEndpoints
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(endpoints)
    .where(and(eq(endpoints.userId, userId), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))
  return { count, limit, exceeded: count >= limit }
}
