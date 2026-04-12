import { Context, Next } from 'hono'
import { createAuth } from '../lib/auth'
import type { Env, AppVariables } from '../types'

interface BetterAuthUser {
  id: string
  name: string | null
  email: string
  plan?: string
}

export async function sessionMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const auth = createAuth(c.env.DB, c.env)
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!session) {
    return c.redirect('/login')
  }

  const u = session.user as BetterAuthUser

  c.set('dashboardAuth', {
    userId: u.id,
    userName: u.name || u.email,
    plan: u.plan || 'free',
  })

  await next()
}
