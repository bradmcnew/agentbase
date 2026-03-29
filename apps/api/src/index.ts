import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { dbMiddleware } from './middleware/db'
import customDomainRoutes from './routes/custom-domain'
import platformRoutes from './routes/platform'
import accountRoutes from './routes/accounts'
import endpointRoutes from './routes/endpoints'
import agentRoutes from './routes/agent'
import skillRoutes from './routes/skills'
import queryRoutes from './routes/query'
import type { Env, AppVariables } from './types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('*', cors())
app.use('*', logger())
app.use('*', dbMiddleware as any)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500)
})

app.route('/', customDomainRoutes)
app.route('/', platformRoutes)
app.route('/', agentRoutes)
app.route('/', accountRoutes)
app.route('/', skillRoutes)
app.route('/', endpointRoutes)
app.route('/', queryRoutes)

app.notFound((c) => {
  return c.json({
    error: { code: 'NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} not found` }
  }, 404)
})

export default app
