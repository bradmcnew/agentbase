import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { endpoints, interactions } from '../db/schema'
import { handleQuery } from '../services/query-handler'
import { generateLlmsTxt } from '../services/skill-gen'
import { errorResponse, ErrorCode } from '../utils/errors'
import { safeJsonParse } from '../utils/validate'
import { ENDPOINT_STATUS } from '../types'
import type { Env, AppVariables } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function resolveBySlug(c: any) {
  const slug = c.req.param('slug')
  if (!slug) return null
  const db = c.get('db')
  const [ep] = await db.select().from(endpoints).where(eq(endpoints.slug, slug)).limit(1)
  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) return null
  return ep
}

app.get('/a/:slug', async (c) => {
  const ep = await resolveBySlug(c)
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
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')
  if (!ep.skillMd) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md not generated yet')
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.get('/a/:slug/llms.txt', async (c) => {
  const ep = await resolveBySlug(c)
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

app.get('/a/:slug/logs', async (c) => {
  const ep = await resolveBySlug(c)
  if (!ep) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'Endpoint not found')

  const db = c.get('db')
  const rows = await db
    .select({
      id: interactions.id, query: interactions.query, response: interactions.response,
      latencyMs: interactions.latencyMs, createdAt: interactions.createdAt,
      confidence: interactions.confidence, confidenceSources: interactions.confidenceSources,
      conversationId: interactions.conversationId,
    })
    .from(interactions)
    .where(eq(interactions.endpointId, ep.id))
    .orderBy(desc(interactions.createdAt))
    .limit(200)

  const flagFor = (c: string | null) =>
    c === 'not_found' ? 'not-found' : c === 'review' ? 'review' : c === 'confident' ? 'confident' : 'unscored'

  // Group by conversation (preserve order by most recent message)
  type Row = typeof rows[number]
  const convMap = new Map<string, Row[]>()
  const convOrder: string[] = []
  for (const r of rows) {
    const key = r.conversationId || r.id // single-turn uses id as key
    if (!convMap.has(key)) {
      convMap.set(key, [])
      convOrder.push(key)
    }
    convMap.get(key)!.push(r)
  }
  // Reverse each group so turns are chronological
  for (const turns of convMap.values()) turns.reverse()

  let confidentCount = 0, reviewCount = 0, notFoundCount = 0
  for (const r of rows) {
    const f = flagFor(r.confidence)
    if (f === 'confident') confidentCount++
    else if (f === 'review') reviewCount++
    else if (f === 'not-found') notFoundCount++
  }

  function renderSources(src: string | null) {
    if (!src) return ''
    return `<div class="sources">${src.split(',').map(s => {
      const url = s.trim()
      const safe = /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i.test(url)
      return safe ? `<a href="https://${esc(url)}" target="_blank">${esc(url)}</a>` : esc(url)
    }).join(', ')}</div>`
  }

  function renderTurn(r: Row, turnNum: number, total: number) {
    const flag = flagFor(r.confidence)
    const label = flag === 'not-found' ? 'NOT FOUND' : flag === 'review' ? 'REVIEW' : flag === 'confident' ? 'CONFIDENT' : '—'
    const latency = r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'
    const turnLabel = total > 1 ? `<span class="turn-num">${turnNum}/${total}</span>` : ''
    return `<div class="turn">
      <div class="turn-header">
        <span class="flag flag-${flag}">${label}</span>${turnLabel}<span class="latency">${latency}</span>
      </div>
      <div class="query-full">${esc(r.query)}</div>
      <div class="response">${esc(r.response)}</div>
      ${renderSources(r.confidenceSources)}
    </div>`
  }

  const logsHtml = convOrder.map(key => {
    const turns = convMap.get(key)!
    const first = turns[0]
    const last = turns[turns.length - 1]
    const flag = flagFor(first.confidence)
    const time = last.createdAt ? last.createdAt.replace('T', ' ').slice(0, 16) : ''
    const isThread = turns.length > 1

    if (!isThread) {
      // Single turn — simple card
      const label = flag === 'not-found' ? 'NOT FOUND' : flag === 'review' ? 'REVIEW' : flag === 'confident' ? 'CONFIDENT' : '—'
      const latency = first.latencyMs ? `${(first.latencyMs / 1000).toFixed(1)}s` : '—'
      return `<div class="log ${flag}" onclick="this.classList.toggle('open')">
        <div class="log-header">
          <span class="flag flag-${flag}">${label}</span>
          <span class="query-preview">${esc(first.query)}</span>
          <span class="time">${esc(time)}</span>
          <span class="latency">${latency}</span>
        </div>
        <div class="log-detail">
          <div class="query-full">${esc(first.query)}</div>
          <div class="response">${esc(first.response)}</div>
          ${renderSources(first.confidenceSources)}
        </div>
      </div>`
    }

    // Multi-turn — stacked card
    const turnsHtml = turns.map((t, i) => renderTurn(t, i + 1, turns.length)).join('\n')
    return `<div class="log-stack ${flag}" onclick="this.classList.toggle('open')">
      <div class="stack-layer"></div>
      <div class="stack-card">
        <div class="log-header">
          <span class="flag flag-${flag}">THREAD</span>
          <span class="query-preview">${esc(first.query)}</span>
          <span class="turn-count">${turns.length} turns</span>
          <span class="time">${esc(time)}</span>
        </div>
        <div class="log-detail">
          ${turnsHtml}
        </div>
      </div>
    </div>`
  }).join('\n')

  const total = rows.length
  const convCount = convOrder.length

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(ep.name)} — Agent Logs</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#09090b; --fg:#fafafa; --border:#1e1e23; --surface:#060608; --surface-alt:#0d0d12; --muted:#9f9fa9; --fg-dim:#ccc; --green:#9ece6a; --red:#f7768e; --yellow:#e0af68 }
    * { margin:0; padding:0; box-sizing:border-box }
    body { background:var(--bg); color:var(--fg); font-family:Inter,system-ui,sans-serif; line-height:1.6; padding:1.5rem; max-width:900px; margin:0 auto }
    h1 { font-family:'JetBrains Mono',monospace; font-size:1.5rem; margin-bottom:0.25rem }
    a { color:var(--green); text-decoration:none }
    .subtitle { color:var(--muted); font-size:0.85em; margin-bottom:1.5rem }
    .stats { display:flex; gap:1.5rem; margin-bottom:1.5rem; font-family:'JetBrains Mono',monospace; flex-wrap:wrap }
    .stat-value { font-size:1.3rem; font-weight:700 }
    .stat-label { font-size:0.7rem; color:var(--muted); margin-top:0.1rem }
    .stat-green .stat-value { color:var(--green) }
    .stat-yellow .stat-value { color:var(--yellow) }
    .stat-red .stat-value { color:var(--red) }
    .filters { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap }
    .filters button { background:var(--surface-alt); border:1px solid var(--border); color:var(--muted); padding:0.4rem 0.8rem; font-size:0.8rem; cursor:pointer; font-family:'JetBrains Mono',monospace }
    .filters button:hover, .filters button.active { color:var(--fg); border-color:var(--fg) }

    .log { padding:0.75rem 1rem; border:1px solid var(--border); margin-bottom:0.5rem; background:var(--surface); cursor:pointer }
    .log.not-found { border-left:3px solid var(--red) }
    .log.review { border-left:3px solid var(--yellow) }
    .log.confident { border-left:3px solid var(--green) }
    .log.unscored { border-left:3px solid var(--border) }

    .log-stack { position:relative; margin-bottom:0.75rem; cursor:pointer }
    .stack-layer { position:absolute; top:4px; left:4px; right:-4px; bottom:-4px; border:1px solid var(--border); background:var(--surface-alt) }
    .stack-card { position:relative; padding:0.75rem 1rem; border:1px solid var(--border); background:var(--surface) }
    .log-stack.not-found .stack-card, .log-stack.not-found .stack-layer { border-left:3px solid var(--red) }
    .log-stack.review .stack-card, .log-stack.review .stack-layer { border-left:3px solid var(--yellow) }
    .log-stack.confident .stack-card, .log-stack.confident .stack-layer { border-left:3px solid var(--green) }

    .log-header { display:flex; align-items:center; gap:0.75rem; font-size:0.8rem }
    .query-preview { font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:var(--fg); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    .turn-count { font-family:'JetBrains Mono',monospace; font-size:0.7rem; color:var(--muted); flex-shrink:0 }
    .log-detail { display:none; margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border) }
    .log.open .log-detail, .log-stack.open .log-detail { display:block }

    .turn { padding:0.75rem 0; border-bottom:1px solid var(--border) }
    .turn:last-child { border-bottom:none }
    .turn-header { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.4rem; font-size:0.75rem }
    .turn-num { font-family:'JetBrains Mono',monospace; color:var(--muted); font-size:0.7rem }

    .flag { font-family:'JetBrains Mono',monospace; font-weight:600; font-size:0.75rem; flex-shrink:0 }
    .flag-not-found { color:var(--red) }
    .flag-review { color:var(--yellow) }
    .flag-confident { color:var(--green) }
    .flag-unscored { color:var(--muted) }
    .time { color:var(--muted); flex-shrink:0 }
    .latency { color:var(--muted); flex-shrink:0 }
    .query-full { font-family:'JetBrains Mono',monospace; font-size:0.9rem; margin-bottom:0.5rem; color:var(--fg) }
    .response { font-size:0.85rem; color:var(--fg-dim); white-space:pre-wrap; word-break:break-word }
    .sources { font-family:'JetBrains Mono',monospace; font-size:0.7rem; color:var(--muted); margin-top:0.4rem }
    .empty { color:var(--muted); text-align:center; padding:3rem; font-style:italic }
    .footer { margin-top:2rem; padding-top:1rem; border-top:1px solid var(--border); color:var(--muted); font-size:0.8rem }
    @media (max-width:600px) {
      body { padding:0.75rem }
      h1 { font-size:1.2rem }
      .stats { gap:1rem }
      .stat-value { font-size:1.1rem }
      .log { padding:0.75rem }
      .stack-layer { right:-3px; bottom:-3px }
    }
  </style>
</head>
<body>
  <h1>${esc(ep.name)} — Agent Logs</h1>
  <div class="subtitle">${total} interactions across ${convCount} conversations &middot; <a href="/a/${esc(ep.slug)}/skill.md">SKILL.md</a></div>

  <div class="stats">
    <div class="stat-green"><div class="stat-value">${confidentCount}</div><div class="stat-label">confident</div></div>
    <div class="stat-yellow"><div class="stat-value">${reviewCount}</div><div class="stat-label">review</div></div>
    <div class="stat-red"><div class="stat-value">${notFoundCount}</div><div class="stat-label">not found</div></div>
  </div>

  <div class="filters">
    <button class="active" onclick="filter('all',this)">All</button>
    <button onclick="filter('review',this)">Review</button>
    <button onclick="filter('not-found',this)">Not Found</button>
  </div>

  ${rows.length === 0 ? '<div class="empty">No interactions yet</div>' : logsHtml}

  <div class="footer">
    Powered by <a href="https://agentbase.to">AgentBase</a> &middot; Auto-refreshes on page load
  </div>

  <script>
    function filter(type, el) {
      document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.log, .log-stack').forEach(el => {
        el.style.display = type === 'all' || el.classList.contains(type) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=10, stale-while-revalidate=30')
  return c.html(html)
})


export default app
