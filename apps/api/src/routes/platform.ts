import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => {
  return c.json({ status: 'ok', version: '0.1.0' })
})

// Platform SKILL.md and llms.txt are served as static files from public/
// via Cloudflare Workers Static Assets. No routes needed here.

export default app
