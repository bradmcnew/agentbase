import { Context, Next } from 'hono'
import { eq, and, ne } from 'drizzle-orm'
import { DrizzleD1Database } from 'drizzle-orm/d1'
import { endpoints } from '../db/schema'
import { errorResponse, ErrorCode } from '../utils/errors'
import { ENDPOINT_STATUS } from '../types'
import type { AuthContext } from '../types'

/** Full endpoint row type inferred from the schema */
export type EndpointRow = typeof endpoints.$inferSelect

/**
 * Middleware that resolves an endpoint by accountId + slug.
 * Requires auth middleware to have run first (reads auth from context).
 * Sets the full endpoint row on context as 'endpoint'.
 *
 * Usage:
 *   app.use('*', authMiddleware)
 *   app.use('*', resolveEndpoint)
 *   app.get('/', (c) => { const ep = c.get('endpoint') })
 */
export async function resolveEndpoint(
  c: Context<{ Variables: { auth: AuthContext; db: DrizzleD1Database; endpoint: EndpointRow } }>,
  next: Next
) {
  const auth = c.get('auth')
  const slug = c.req.param('slug')
  if (!slug) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Endpoint slug is required')
  }

  const db = c.get('db')
  const [endpoint] = await db
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.accountId, auth.accountId), eq(endpoints.slug, slug), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))
    .limit(1)

  if (!endpoint) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, `Endpoint "${slug}" not found`)
  }

  c.set('endpoint', endpoint)
  await next()
}
