import { Context, Next } from 'hono'
import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1'
import type { Env } from '../types'

/** Initialize Drizzle once per request and set on context */
export async function dbMiddleware(c: Context<{ Bindings: Env; Variables: { db: DrizzleD1Database } }>, next: Next) {
  c.set('db', drizzle(c.env.DB))
  await next()
}
