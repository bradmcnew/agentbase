import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { dbMiddleware } from './middleware/db'
import authRoutes from './routes/auth'
import authPageRoutes from './routes/auth-pages'
import dashboardRoutes from './routes/dashboard'
import customDomainRoutes from './routes/custom-domain'
import platformRoutes from './routes/platform'
import accountRoutes from './routes/accounts'
import endpointRoutes from './routes/endpoints'
import agentRoutes from './routes/agent'
import skillRoutes from './routes/skills'
import queryRoutes from './routes/query'
import type { Env, AppVariables } from './types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// CORS only on public API routes — dashboard and auth are same-origin
app.use('/v1/*', cors())
app.use('/a/*', cors())
app.use('/query', cors())
app.use('/skill.md', cors())
app.use('/health', cors())
app.use('*', logger())
app.use('*', dbMiddleware as any)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500)
})

app.route('/', authRoutes)
app.route('/', authPageRoutes)
app.route('/', dashboardRoutes)
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
