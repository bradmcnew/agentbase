import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth } from '../lib/auth'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('/api/auth/*', cors({
  origin: (origin, c) => {
    const allowed = [c.env.BETTER_AUTH_URL, 'http://localhost:8787']
    return allowed.includes(origin) ? origin : c.env.BETTER_AUTH_URL
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}))

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const auth = createAuth(c.env.DB, c.env)
  return auth.handler(c.req.raw)
})

export default app
