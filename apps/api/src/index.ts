import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { dbMiddleware } from './middleware/db'
import customDomainRoutes from './routes/custom-domain'
import platformRoutes from './routes/platform'
import accountRoutes from './routes/accounts'
import endpointRoutes from './routes/endpoints'
import documentRoutes from './routes/documents'
import queryRoutes from './routes/query'
import skillRoutes from './routes/skills'
import type { Env, AppVariables } from './types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// Global middleware
app.use('*', cors())
app.use('*', logger())
app.use('*', dbMiddleware as any)

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500)
})

// Mount routes (order matters: custom domain first, then public, then auth-protected)
app.route('/', customDomainRoutes)
app.route('/', platformRoutes)
app.route('/', accountRoutes)
app.route('/', skillRoutes)
app.route('/', endpointRoutes)
app.route('/', documentRoutes)
app.route('/', queryRoutes)

// 404 handler
app.notFound((c) => {
  return c.json({
    error: { code: 'NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} not found. See /.well-known/skill.md for available endpoints.` }
  }, 404)
})

export default app
