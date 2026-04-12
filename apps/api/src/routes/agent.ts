import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { endpoints } from '../db/schema'
import { handleQuery } from '../services/query-handler'
import { generateLlmsTxt } from '../services/skill-gen'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse } from '../utils/validate'
import { ENDPOINT_STATUS } from '../types'
import { esc } from '../lib/html'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()


async function resolveBySlug(c: any) {
  const slug = c.req.param('slug')
  if (!slug) return null
  const db = c.get('db')
  const [ep] = await db.select().from(endpoints).where(eq(endpoints.slug, slug)).limit(1)
  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) return null
  return ep
}

async function resolveBySlugLite(c: any) {
  const slug = c.req.param('slug')
  if (!slug) return null
  const db = c.get('db')
  const [ep] = await db.select({
    id: endpoints.id, slug: endpoints.slug, name: endpoints.name,
    description: endpoints.description, status: endpoints.status,
    queryCount: endpoints.queryCount, capabilities: endpoints.capabilities,
    skillMd: endpoints.skillMd,
  }).from(endpoints).where(eq(endpoints.slug, slug)).limit(1)
  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) return null
  return ep
}

// Trailing slash redirect — prevents fallthrough to auth routes
app.get('/a/:slug/', (c) => c.redirect(`/a/${c.req.param('slug')}`, 301))

app.get('/a/:slug', async (c) => {
  const ep = await resolveBySlugLite(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')

  const domain = ep.slug.replace(/-/g, '.')
  const productName = domain.replace(/\.[^.]+$/, '').replace(/^./, (ch: string) => ch.toUpperCase())

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(ep.name)} — AgentBase</title>
  <meta name="description" content="Is ${esc(productName)} agent-ready? Agents are trying to interact with ${esc(domain)} — claim this endpoint.">
  <meta property="og:title" content="${esc(productName)} — AgentBase">
  <meta property="og:description" content="Is ${esc(productName)} agent-ready?">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#09090b; --fg:#fafafa; --border:#1e1e23; --surface:#060608; --surface-alt:#0d0d12; --muted:#9f9fa9; --fg-dim:#ccc; --green:#9ece6a; --red:#f7768e }
    * { margin:0; padding:0; box-sizing:border-box }
    body { background:var(--bg); color:var(--fg); font-family:Inter,system-ui,sans-serif; line-height:1.6; padding:1.5rem; max-width:700px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; justify-content:center }
    h1 { font-family:'JetBrains Mono',monospace; font-size:1.5rem; margin-bottom:0.5rem; word-break:break-word }
    a { color:var(--green); text-decoration:none }
    .domain { font-family:'JetBrains Mono',monospace; font-size:0.95rem; margin-bottom:1.5rem }
    .desc { color:var(--fg-dim); font-size:1rem; line-height:1.7; margin-bottom:2rem }
    .stats { display:flex; gap:2rem; margin-bottom:2rem; flex-wrap:wrap }
    .stat { font-family:'JetBrains Mono',monospace }
    .stat-value { font-size:1.3rem; font-weight:700; color:var(--fg) }
    .stat-label { font-size:0.75rem; color:var(--muted); margin-top:0.15rem }
    .endpoints { margin-bottom:2rem; padding:1rem; border:1px solid var(--border); background:var(--surface-alt); font-family:'JetBrains Mono',monospace; font-size:0.85em; color:var(--muted); display:flex; flex-direction:column; gap:0.4rem }
    .claim { margin-bottom:2rem; padding:1.5rem; border:1px solid var(--border); border-top:3px solid var(--green); background:var(--surface-alt) }
    .claim-title { font-family:'JetBrains Mono',monospace; font-weight:700; font-size:0.95em; margin-bottom:0.75rem; display:flex; align-items:center; gap:0.5rem }
    .claim-title::before { content:''; display:inline-block; width:6px; height:6px; background:var(--green); border-radius:50% }
    .claim-text { color:var(--fg-dim); font-size:0.9em; line-height:1.7; margin-bottom:1rem }
    .claim-contact { font-size:0.9em }
    .claim-contact a { font-weight:500 }
    .footer { margin-top:2rem; padding-top:1rem; border-top:1px solid var(--border); color:var(--muted); font-size:0.8rem; line-height:1.8 }
    @media (max-width:600px) {
      body { padding:1rem; justify-content:flex-start; padding-top:2rem }
      h1 { font-size:1.2rem }
      .stats { gap:1.5rem }
      .stat-value { font-size:1.1rem }
      .claim { padding:1.25rem }
    }
  </style>
</head>
<body>
  <div>
    <h1>${esc(productName)}</h1>
    <div class="domain"><a href="https://${esc(domain)}">${esc(domain)}</a></div>
    <div class="desc">${ep.description ? esc(ep.description) : `${esc(productName)}'s representative in the agent economy. AI agents can query this endpoint to get answers, take actions, and transact on behalf of ${esc(domain)}.`}</div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${ep.queryCount.toLocaleString()}</div>
        <div class="stat-label">agent queries</div>
      </div>
      <div class="stat">
        <div class="stat-value">live</div>
        <div class="stat-label">status</div>
      </div>
    </div>

    <div class="endpoints">
      <div>Query &nbsp;<a href="/a/${esc(ep.slug)}/query">/a/${esc(ep.slug)}/query</a></div>
      <div>Skill &nbsp;<a href="/a/${esc(ep.slug)}/skill.md">/a/${esc(ep.slug)}/skill.md</a></div>
    </div>

    <div class="claim">
      <div class="claim-title">Is this your company?</div>
      <div class="claim-text">${esc(domain)} isn't agent-ready. Agents are trying to interact with your product — claim this endpoint.</div>
      <div class="claim-contact">
        <a href="https://x.com/bmcnew_">DM @bmcnew_ to claim &rarr;</a>
      </div>
    </div>

    <div class="footer">
      Powered by <a href="https://agentbase.to">AgentBase</a> — your representative in the agent economy
    </div>
  </div>
</body>
</html>`

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.html(html)
})

app.get('/a/:slug/skill.md', async (c) => {
  const ep = await resolveBySlugLite(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  if (!ep.skillMd) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md not generated yet')
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.get('/a/:slug/llms.txt', async (c) => {
  const ep = await resolveBySlugLite(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  const baseUrl = new URL(c.req.url).origin
  const llmsTxt = generateLlmsTxt({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id,
  })
  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(llmsTxt)
})

app.post('/a/:slug/query', async (c) => {
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  return handleQuery(c, ep)
})

export default app
