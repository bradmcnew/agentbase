import { Hono } from 'hono'
import { eq, and, ne, desc } from 'drizzle-orm'
import { endpoints, interactions } from '../db/schema'
import { sessionMiddleware } from '../middleware/session'
import { dashboardLayout, esc, copyBox } from '../lib/html'
import { generateId } from '../utils/id'
import { generateSkillMd } from '../services/skill-gen'
import { encrypt } from '../utils/encrypt'
import { safeJsonParse } from '../utils/validate'
import { findEndpointLite, checkEndpointLimit } from '../utils/queries'
import { ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS, CONFIDENCE } from '../types'
import type { Env, AppVariables } from '../types'

const LOG_LIMIT = 50
const KNOWLEDGE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(md|txt)$/
const MAX_KNOWLEDGE_SIZE = 512_000 // 500 KB

const openclawAgentId = (ep: { externalModel: string | null; slug: string }) =>
  ep.externalModel?.replace('openclaw/', '') || ep.slug

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('/dashboard/*', sessionMiddleware as any)
app.use('/dashboard', sessionMiddleware as any)

// ── Agent list (home) ──

app.get('/dashboard', async (c) => {
  const { userId, userName, plan } = c.get('dashboardAuth')
  const db = c.get('db')

  const results = await db
    .select({
      id: endpoints.id, slug: endpoints.slug, name: endpoints.name,
      description: endpoints.description, status: endpoints.status,
      queryCount: endpoints.queryCount, createdAt: endpoints.createdAt,
    })
    .from(endpoints)
    .where(and(eq(endpoints.userId, userId), ne(endpoints.status, ENDPOINT_STATUS.ARCHIVED)))

  const maxEndpoints = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]?.maxEndpoints ?? PLAN_LIMITS.free.maxEndpoints
  const atLimit = results.length >= maxEndpoints

  const agentCards = results.length === 0
    ? '<div class="empty">No agents yet. Create your first one.</div>'
    : results.map(ep => `
      <a class="card" href="/dashboard/agents/${esc(ep.slug)}">
        <div class="card-title">${esc(ep.name)}</div>
        <div class="card-meta">${esc(ep.slug)} &middot; ${ep.queryCount} queries &middot; ${esc(ep.status)}</div>
      </a>
    `).join('')

  const html = dashboardLayout({ title: 'Agents', userName, activePage: 'agents' }, `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
      <h1 class="page-title" style="margin-bottom:0">Agents</h1>
      ${atLimit
        ? '<span class="btn btn-disabled" title="Free plan limit reached">Create agent</span>'
        : '<a class="btn" href="/dashboard/agents/new">Create agent</a>'}
    </div>
    ${atLimit ? '<div style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">Free plan limit reached (1 agent). Upgrade to create more.</div>' : ''}
    ${agentCards}
  `)

  return c.html(html)
})

// ── Create agent form ──

app.get('/dashboard/agents/new', async (c) => {
  const { userName } = c.get('dashboardAuth')

  const html = dashboardLayout({ title: 'Create Agent', userName, activePage: 'agents' }, `
    <h1 class="page-title">New Agent</h1>
    <p class="page-subtitle">Deploy an agent endpoint in seconds.</p>
    ${c.req.query('error') === 'limit' ? '<div class="card" style="border-left:3px solid var(--red);color:var(--red);font-size:0.85rem">You\'ve reached your free plan limit (1 agent). Upgrade to create more.</div>' : ''}
    ${c.req.query('error') === 'provision' ? '<div class="card" style="border-left:3px solid var(--red);color:var(--red);font-size:0.85rem">Failed to provision agent. Please try again.</div>' : ''}

    <form method="POST" action="/dashboard/api/agents">
      <label class="label">Name</label>
      <input class="input" name="name" placeholder="e.g. Acme Support" required>

      <button class="btn" type="submit" style="margin-top:1.5rem">Create agent</button>
    </form>

    <div style="display:flex;align-items:center;gap:0.75rem;margin:2rem 0">
      <div style="flex:1;height:1px;background:var(--border)"></div>
      <span style="color:var(--muted);font-size:0.8rem">or</span>
      <div style="flex:1;height:1px;background:var(--border)"></div>
    </div>

    <div class="card" style="border-top:2px solid var(--green)">
      <div class="card-title">Already have an agent?</div>
      <div style="font-size:0.85rem;color:var(--fg-dim);margin:0.5rem 0 1rem">Give it this URL. It contains instructions to register itself via our API.</div>
      ${copyBox('https://agentbase.to/skill.md')}
    </div>
  `)

  return c.html(html)
})

// ── Create agent handler ──

app.post('/dashboard/api/agents', async (c) => {
  const { userId, plan } = c.get('dashboardAuth')
  const db = c.get('db')
  const body = await c.req.parseBody()

  const name = (body.name as string || '').trim()
  if (!name) return c.redirect('/dashboard/agents/new')

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100)
  if (!slug) return c.redirect('/dashboard/agents/new')

  const { exceeded } = await checkEndpointLimit(db, userId, plan)
  if (exceeded) return c.redirect('/dashboard/agents/new?error=limit')

  // Check slug uniqueness for this user, append random suffix if taken
  let finalSlug = slug
  const [existing] = await db.select({ id: endpoints.id, status: endpoints.status })
    .from(endpoints).where(and(eq(endpoints.slug, finalSlug), eq(endpoints.userId, userId))).limit(1)

  if (existing && existing.status !== ENDPOINT_STATUS.ARCHIVED) {
    finalSlug = `${slug}-${generateId().slice(0, 6)}`
  } else if (existing) {
    await db.delete(interactions).where(eq(interactions.endpointId, existing.id))
    await db.delete(endpoints).where(eq(endpoints.id, existing.id))
  }

  // Provision OpenClaw agent
  try {
    const provisionRes = await fetch(`${c.env.OPENCLAW_PROVISION_URL}/provision`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.OPENCLAW_PROVISION_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId: finalSlug, name }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!provisionRes.ok && provisionRes.status !== 409) {
      console.error('OpenClaw provisioning failed:', await provisionRes.text().catch(() => ''))
      return c.redirect('/dashboard/agents/new?error=provision')
    }
  } catch (err) {
    console.error('OpenClaw provisioning error:', err)
    return c.redirect('/dashboard/agents/new?error=provision')
  }

  const endpointId = generateId()
  const baseUrl = new URL(c.req.url).origin
  const webhookSecret = `whsec_${generateId()}`

  const skillMd = generateSkillMd({ slug: finalSlug, name, capabilities: [], baseUrl, endpointId })
  const [encryptedSecret, encryptedToken] = await Promise.all([
    encrypt(webhookSecret, c.env.ENCRYPTION_SECRET),
    encrypt(c.env.OPENCLAW_GATEWAY_TOKEN, c.env.ENCRYPTION_SECRET),
  ])

  await db.insert(endpoints).values({
    id: endpointId, userId, slug: finalSlug, name,
    mode: ENDPOINT_MODE.EXTERNAL,
    webhookUrl: c.env.OPENCLAW_GATEWAY_URL,
    webhookSecret: encryptedSecret,
    externalModel: `openclaw/${finalSlug}`,
    externalApiKey: encryptedToken,
    capabilities: '[]',
    skillMd,
  })

  return c.redirect(`/dashboard/agents/${finalSlug}`)
})

// ── Agent detail (logs) ──

app.get('/dashboard/agents/:slug', async (c) => {
  const { userId, userName } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.redirect('/dashboard')

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
    .limit(LOG_LIMIT)

  const flagFor = (conf: string | null) =>
    conf === CONFIDENCE.NOT_FOUND ? 'not-found' : conf === CONFIDENCE.REVIEW ? 'review' : conf === CONFIDENCE.CONFIDENT ? 'confident' : 'unscored'

  const labelFor = (flag: string) =>
    flag === 'not-found' ? 'NOT FOUND' : flag === 'review' ? 'REVIEW' : flag === 'confident' ? 'CONFIDENT' : '\u2014'

  const fmtLatency = (ms: number | null) =>
    ms ? `${(ms / 1000).toFixed(1)}s` : '\u2014'

  type Row = typeof rows[number]
  const convMap = new Map<string, Row[]>()
  const convOrder: string[] = []
  let confidentCount = 0, reviewCount = 0, notFoundCount = 0

  for (const r of rows) {
    const key = r.conversationId || r.id
    if (!convMap.has(key)) {
      convMap.set(key, [])
      convOrder.push(key)
    }
    convMap.get(key)!.push(r)
    const f = flagFor(r.confidence)
    if (f === 'confident') confidentCount++
    else if (f === 'review') reviewCount++
    else if (f === 'not-found') notFoundCount++
  }
  for (const turns of convMap.values()) turns.reverse()

  function renderSources(src: string | null) {
    if (!src) return ''
    return `<div class="log-sources">${src.split(',').map(s => {
      const url = s.trim()
      const safe = /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i.test(url)
      return safe ? `<a href="https://${esc(url)}" target="_blank">${esc(url)}</a>` : esc(url)
    }).join(', ')}</div>`
  }

  function renderContent(r: Row) {
    return `<div class="log-query">${esc(r.query)}</div>
      <div class="log-response">${esc(r.response)}</div>
      ${renderSources(r.confidenceSources)}`
  }

  function renderTurn(r: Row, turnNum: number, total: number) {
    const flag = flagFor(r.confidence)
    const turnLabel = total > 1 ? `<span class="log-turn-num">${turnNum}/${total}</span>` : ''
    return `<div class="log-turn">
      <div class="log-turn-header">
        <span class="flag flag-${flag}">${labelFor(flag)}</span>${turnLabel}<span class="log-latency">${fmtLatency(r.latencyMs)}</span>
      </div>
      ${renderContent(r)}
    </div>`
  }

  const logsHtml = convOrder.length === 0
    ? '<div class="empty">No interactions yet. Send a query to your agent to see logs here.</div>'
    : convOrder.map(key => {
      const turns = convMap.get(key)!
      const first = turns[0]
      const last = turns[turns.length - 1]
      const flag = flagFor(first.confidence)
      const time = last.createdAt ? last.createdAt.replace('T', ' ').slice(0, 16) : ''

      if (turns.length === 1) {
        return `<div class="log-item ${flag}" onclick="this.classList.toggle('open')">
          <div class="log-header">
            <span class="flag flag-${flag}">${labelFor(flag)}</span>
            <span class="log-preview">${esc(first.query)}</span>
            <span class="log-time">${esc(time)}</span>
            <span class="log-latency">${fmtLatency(first.latencyMs)}</span>
          </div>
          <div class="log-detail">
            ${renderContent(first)}
          </div>
        </div>`
      }

      const turnsHtml = turns.map((t, i) => renderTurn(t, i + 1, turns.length)).join('\n')
      return `<div class="log-stack ${flag}" onclick="this.classList.toggle('open')">
        <div class="log-stack-layer"></div>
        <div class="log-stack-card">
          <div class="log-header">
            <span class="flag flag-${flag}">THREAD</span>
            <span class="log-preview">${esc(first.query)}</span>
            <span class="log-turn-count">${turns.length} turns</span>
            <span class="log-time">${esc(time)}</span>
          </div>
          <div class="log-detail">
            ${turnsHtml}
          </div>
        </div>
      </div>`
    }).join('\n')

  const convCount = convOrder.length

  const html = dashboardLayout({ title: ep.name, userName, activePage: 'agents' }, `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
      <h1 class="page-title" style="margin-bottom:0">${esc(ep.name)}</h1>
      <div style="display:flex;gap:0.5rem">
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}/knowledge">Knowledge</a>
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}/test">Test</a>
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}/settings">Settings</a>
      </div>
    </div>
    <p class="page-subtitle">${esc(ep.slug)} &middot; ${ep.queryCount} queries &middot; ${convCount} conversations &middot; <a href="/a/${esc(ep.slug)}/skill.md" target="_blank">SKILL.md</a></p>

    ${!ep.webhookUrl ? `
    <div class="card" style="border-top:3px solid var(--yellow);margin-bottom:1.5rem">
      <div style="font-family:'JetBrains Mono',monospace;font-weight:600;font-size:0.9rem;margin-bottom:0.5rem">Connect your agent</div>
      <div style="font-size:0.85rem;color:var(--fg-dim);margin-bottom:1rem">Your agent endpoint is live. Point your agent at the SKILL.md or add your webhook URL in settings.</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem">SKILL.md</div>
      ${copyBox(`https://agentbase.to/a/${esc(ep.slug)}/skill.md`)}
      <a class="btn" href="/dashboard/agents/${esc(ep.slug)}/settings" style="font-size:0.8rem;margin-top:0.75rem">Add webhook URL</a>
    </div>
    ` : ''}

    <div class="stats">
      <div class="stat stat-green"><div class="stat-value">${confidentCount}</div><div class="stat-label">confident</div></div>
      <div class="stat stat-yellow"><div class="stat-value">${reviewCount}</div><div class="stat-label">review</div></div>
      <div class="stat stat-red"><div class="stat-value">${notFoundCount}</div><div class="stat-label">not found</div></div>
    </div>

    <div class="log-filters">
      <button class="active" onclick="filterLogs('all',this)">All</button>
      <button onclick="filterLogs('review',this)">Review</button>
      <button onclick="filterLogs('not-found',this)">Not Found</button>
    </div>

    ${logsHtml}

    <script>
      function filterLogs(type, el) {
        document.querySelectorAll('.log-filters button').forEach(b => b.classList.remove('active'));
        el.classList.add('active');
        document.querySelectorAll('.log-item, .log-stack').forEach(el => {
          el.style.display = type === 'all' || el.classList.contains(type) ? '' : 'none';
        });
      }
    </script>
  `)

  return c.html(html)
})

// ── Test playground ──

app.get('/dashboard/agents/:slug/test', async (c) => {
  const { userId, userName } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.redirect('/dashboard')

  const html = dashboardLayout({ title: `Test — ${ep.name}`, userName, activePage: 'agents' }, `
    <h1 class="page-title">Test — ${esc(ep.name)}</h1>
    <p class="page-subtitle">Send a query to your agent and see the response.</p>

    <div style="margin-bottom:1rem">
      <textarea class="textarea" id="query-input" placeholder="Ask your agent something..." rows="3"></textarea>
      <button class="btn" id="send-btn" style="margin-top:0.5rem">Send query</button>
    </div>

    <div id="result" style="display:none">
      <div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:0.5rem">
        <span class="flag" id="result-confidence"></span>
        <span style="color:var(--muted);font-size:0.8rem" id="result-latency"></span>
      </div>
      <div class="card" style="white-space:pre-wrap;word-break:break-word;font-size:0.9rem" id="result-text"></div>
    </div>

    <div style="margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--border)">
      <div style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem">Test from Claude Code or any AI agent</div>
      <div style="font-size:0.85rem;color:var(--fg-dim);margin-bottom:0.75rem">Give your agent's SKILL.md to any AI tool and it can query your agent directly.</div>
      ${copyBox(`https://agentbase.to/a/${esc(ep.slug)}/skill.md`)}
    </div>

    <script>
      const slug = '${esc(ep.slug)}'
      let conversationId = null

      document.getElementById('query-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          document.getElementById('send-btn').click()
        }
      })

      document.getElementById('send-btn').addEventListener('click', async () => {
        const input = document.getElementById('query-input')
        const query = input.value.trim()
        if (!query) return

        const btn = document.getElementById('send-btn')
        btn.disabled = true
        btn.textContent = 'Sending...'

        const start = Date.now()
        try {
          const res = await fetch('/a/' + slug + '/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, conversation_id: conversationId }),
          })
          const data = await res.json()
          const latency = Date.now() - start

          const result = document.getElementById('result')
          const conf = document.getElementById('result-confidence')
          const lat = document.getElementById('result-latency')
          const text = document.getElementById('result-text')

          result.style.display = 'block'
          text.textContent = data.answer || data.error?.message || 'No response'
          lat.textContent = (latency / 1000).toFixed(1) + 's'

          const c = data.confidence || 'unscored'
          conf.textContent = c.toUpperCase()
          conf.className = 'flag flag-' + (c === 'confident' ? 'confident' : c === 'review' ? 'review' : c === 'not_found' ? 'not-found' : '')

          if (data.conversation_id) conversationId = data.conversation_id
        } catch {
          document.getElementById('result').style.display = 'block'
          document.getElementById('result-text').textContent = 'Failed to reach agent.'
        }
        btn.disabled = false
        btn.textContent = 'Send query'
      })
    </script>
  `)

  return c.html(html)
})

// ── Knowledge management ──

app.get('/dashboard/agents/:slug/knowledge', async (c) => {
  const { userId, userName } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.redirect('/dashboard')

  const agentId = openclawAgentId(ep)
  let files: Array<{ name: string; size: number; modified: string }> = []

  try {
    const res = await fetch(`${c.env.OPENCLAW_PROVISION_URL}/knowledge/${agentId}`, {
      headers: { 'Authorization': `Bearer ${c.env.OPENCLAW_PROVISION_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = await res.json() as { files: typeof files }
      files = data.files
    }
  } catch (err) { console.error('Knowledge fetch failed:', err) }

  const filesHtml = files.length === 0
    ? '<div class="empty">No knowledge files yet. Upload documents to teach your agent.</div>'
    : files.map(f => {
      const sizeKb = (f.size / 1024).toFixed(1)
      const modified = f.modified.replace('T', ' ').slice(0, 16)
      const safeId = f.name.replace(/[^a-zA-Z0-9]/g, '-')
      return `<div class="card" id="file-${safeId}" style="cursor:pointer" onclick="toggleFile('${esc(f.name)}', '${safeId}')">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">${esc(f.name)}</span>
            <span style="color:var(--muted);font-size:0.75rem;margin-left:0.75rem">${sizeKb} KB &middot; ${esc(modified)}</span>
          </div>
          <div style="display:flex;gap:0.5rem" onclick="event.stopPropagation()">
            <button class="btn btn-outline" style="font-size:0.75rem;padding:0.3rem 0.6rem" onclick="startEdit('${esc(f.name)}', '${safeId}')">Edit</button>
            <button class="btn btn-outline" style="font-size:0.75rem;padding:0.3rem 0.6rem;color:var(--red);border-color:var(--red)" onclick="deleteFile('${esc(f.name)}')">Delete</button>
          </div>
        </div>
        <div id="content-${safeId}" style="display:none;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border)" onclick="event.stopPropagation()">
          <pre id="view-${safeId}" style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--fg-dim);white-space:pre-wrap;word-break:break-word"></pre>
          <div id="edit-${safeId}" style="display:none">
            <textarea class="textarea" id="editor-${safeId}" rows="12" style="font-size:0.8rem"></textarea>
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
              <button class="btn" style="font-size:0.75rem;padding:0.3rem 0.6rem" onclick="saveFile('${esc(f.name)}', '${safeId}')">Save</button>
              <button class="btn btn-outline" style="font-size:0.75rem;padding:0.3rem 0.6rem" onclick="cancelEdit('${safeId}')">Cancel</button>
            </div>
          </div>
        </div>
      </div>`
    }).join('')

  const html = dashboardLayout({ title: `Knowledge — ${ep.name}`, userName, activePage: 'agents' }, `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
      <h1 class="page-title" style="margin-bottom:0">Knowledge</h1>
      <div style="display:flex;gap:0.5rem">
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}">Logs</a>
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}/test">Test</a>
        <a class="btn btn-outline" href="/dashboard/agents/${esc(ep.slug)}/settings">Settings</a>
      </div>
    </div>
    <p class="page-subtitle">${esc(ep.name)} &middot; ${files.length} files</p>

    <div class="card" style="border-top:2px solid var(--green);margin-bottom:1.5rem">
      <div style="font-family:'JetBrains Mono',monospace;font-weight:600;font-size:0.9rem;margin-bottom:0.5rem">Upload knowledge</div>
      <div style="font-size:0.85rem;color:var(--fg-dim);margin-bottom:1rem">Upload .md or .txt files to teach your agent about your product, docs, or FAQs.</div>
      <input type="file" id="file-input" accept=".md,.txt" multiple style="display:none">
      <div style="display:flex;gap:0.5rem;align-items:center">
        <button class="btn" onclick="document.getElementById('file-input').click()" id="upload-btn">Choose files</button>
        <span id="file-status" style="font-size:0.8rem;color:var(--muted)"></span>
      </div>
    </div>

    ${filesHtml}

    <script>
      const slug = '${esc(ep.slug)}'
      const loaded = {}

      async function toggleFile(name, id) {
        const el = document.getElementById('content-' + id)
        if (el.style.display !== 'none') { el.style.display = 'none'; return }
        el.style.display = 'block'
        if (loaded[name]) return
        const view = document.getElementById('view-' + id)
        view.textContent = 'Loading...'
        const res = await fetch('/dashboard/api/agents/' + slug + '/knowledge/' + encodeURIComponent(name))
        if (res.ok) {
          const data = await res.json()
          view.textContent = data.content
          loaded[name] = data.content
        } else {
          view.textContent = 'Failed to load file.'
        }
      }

      function startEdit(name, id) {
        toggleFile(name, id).then(() => {
          const editor = document.getElementById('editor-' + id)
          editor.value = loaded[name] || ''
          document.getElementById('view-' + id).style.display = 'none'
          document.getElementById('edit-' + id).style.display = 'block'
          document.getElementById('content-' + id).style.display = 'block'
        })
      }

      function cancelEdit(id) {
        document.getElementById('edit-' + id).style.display = 'none'
        document.getElementById('view-' + id).style.display = 'block'
      }

      async function saveFile(name, id) {
        const content = document.getElementById('editor-' + id).value
        const res = await fetch('/dashboard/api/agents/' + slug + '/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, content }),
        })
        if (res.ok) {
          loaded[name] = content
          document.getElementById('view-' + id).textContent = content
          cancelEdit(id)
        }
      }

      document.getElementById('file-input').addEventListener('change', async (e) => {
        const files = e.target.files
        if (!files.length) return
        const btn = document.getElementById('upload-btn')
        const status = document.getElementById('file-status')
        btn.disabled = true
        btn.textContent = 'Uploading...'

        let uploaded = 0
        for (const file of files) {
          status.textContent = 'Uploading ' + file.name + '...'
          const content = await file.text()
          const res = await fetch('/dashboard/api/agents/' + slug + '/knowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, content }),
          })
          if (res.ok) uploaded++
          else status.textContent = 'Failed to upload ' + file.name
        }

        btn.disabled = false
        btn.textContent = 'Choose files'
        if (uploaded > 0) location.reload()
      })

      async function deleteFile(name) {
        if (!confirm('Delete ' + name + '?')) return
        const res = await fetch('/dashboard/api/agents/' + slug + '/knowledge', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (res.ok) location.reload()
      }
    </script>
  `)

  return c.html(html)
})

// ── Knowledge API ──

app.get('/dashboard/api/agents/:slug/knowledge/:filename', async (c) => {
  const { userId } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.json({ error: 'not found' }, 404)

  const filename = c.req.param('filename')
  if (!KNOWLEDGE_FILENAME_RE.test(filename)) return c.json({ error: 'invalid filename' }, 400)

  const agentId = openclawAgentId(ep)

  try {
    const res = await fetch(`${c.env.OPENCLAW_PROVISION_URL}/knowledge/${agentId}/${encodeURIComponent(filename)}`, {
      headers: { 'Authorization': `Bearer ${c.env.OPENCLAW_PROVISION_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return c.json({ error: 'file not found' }, res.status as any)
    const data = await res.json() as { name: string; content: string }
    return c.json(data)
  } catch {
    return c.json({ error: 'failed to read file' }, 502)
  }
})

app.post('/dashboard/api/agents/:slug/knowledge', async (c) => {
  const { userId } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.json({ error: 'not found' }, 404)

  let body: { name: string; content: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (!body.name || !body.content) return c.json({ error: 'name and content required' }, 400)
  if (!KNOWLEDGE_FILENAME_RE.test(body.name)) return c.json({ error: 'invalid filename' }, 400)
  if (body.content.length > MAX_KNOWLEDGE_SIZE) return c.json({ error: 'file too large (500KB max)' }, 400)

  const agentId = openclawAgentId(ep)

  try {
    const res = await fetch(`${c.env.OPENCLAW_PROVISION_URL}/knowledge/${agentId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.OPENCLAW_PROVISION_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: body.name, content: body.content }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'upload failed' })) as { error: string }
      return c.json({ error: err.error }, res.status as any)
    }
  } catch {
    return c.json({ error: 'upload failed' }, 502)
  }

  return c.json({ success: true })
})

app.delete('/dashboard/api/agents/:slug/knowledge', async (c) => {
  const { userId } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.json({ error: 'not found' }, 404)

  let body: { name: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (!body.name) return c.json({ error: 'name required' }, 400)
  if (!KNOWLEDGE_FILENAME_RE.test(body.name)) return c.json({ error: 'invalid filename' }, 400)

  const agentId = openclawAgentId(ep)

  try {
    const res = await fetch(`${c.env.OPENCLAW_PROVISION_URL}/knowledge/${agentId}/${encodeURIComponent(body.name)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${c.env.OPENCLAW_PROVISION_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return c.json({ error: 'delete failed' }, res.status as any)
  } catch {
    return c.json({ error: 'delete failed' }, 502)
  }

  return c.json({ success: true })
})

// ── Agent settings ──

app.get('/dashboard/agents/:slug/settings', async (c) => {
  const { userId, userName } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.redirect('/dashboard')

  const caps = safeJsonParse(ep.capabilities, [])

  const html = dashboardLayout({ title: `Settings — ${ep.name}`, userName, activePage: 'agents' }, `
    <h1 class="page-title">Settings — ${esc(ep.name)}</h1>
    <p class="page-subtitle">${esc(ep.slug)}</p>

    <form method="POST" action="/dashboard/agents/${esc(ep.slug)}/settings">
      <label class="label">Name</label>
      <input class="input" name="name" value="${esc(ep.name)}" required>

      <label class="label">Description</label>
      <textarea class="textarea" name="description" rows="3">${esc(ep.description || '')}</textarea>

      ${ep.externalModel?.startsWith('openclaw/') ? '' : `
      <label class="label">Webhook URL</label>
      <input class="input" name="webhook_url" type="url" value="${esc(ep.webhookUrl || '')}">

      <label class="label">System Prompt</label>
      <textarea class="textarea" name="system_prompt" rows="4">${esc(ep.systemPrompt || '')}</textarea>
      `}

      <label class="label">Status</label>
      <select class="input" name="status">
        <option value="${ENDPOINT_STATUS.ACTIVE}" ${ep.status === ENDPOINT_STATUS.ACTIVE ? 'selected' : ''}>Active</option>
        <option value="${ENDPOINT_STATUS.PAUSED}" ${ep.status === ENDPOINT_STATUS.PAUSED ? 'selected' : ''}>Paused</option>
      </select>

      <button class="btn" type="submit" style="margin-top:1.5rem">Save changes</button>
    </form>
  `)

  return c.html(html)
})

// ── Save settings handler ──

app.post('/dashboard/agents/:slug/settings', async (c) => {
  const { userId } = c.get('dashboardAuth')
  const db = c.get('db')
  const ep = await findEndpointLite(db, userId, c.req.param('slug'))
  if (!ep) return c.redirect('/dashboard')

  const body = await c.req.parseBody()
  const updates: Record<string, unknown> = {}

  if (body.name) updates.name = (body.name as string).trim()
  if (body.description !== undefined) updates.description = (body.description as string).trim() || null
  if (body.webhook_url) {
    const url = (body.webhook_url as string).trim()
    if (url.startsWith('https://')) updates.webhookUrl = url
  }
  if (body.system_prompt !== undefined) updates.systemPrompt = (body.system_prompt as string).trim() || null
  if (body.status === ENDPOINT_STATUS.ACTIVE || body.status === ENDPOINT_STATUS.PAUSED) {
    updates.status = body.status
  }
  const parsedCaps = body.capabilities !== undefined
    ? (body.capabilities as string).split(',').map(s => s.trim()).filter(Boolean)
    : null
  if (parsedCaps) updates.capabilities = JSON.stringify(parsedCaps)

  // Regenerate SKILL.md only when relevant fields changed
  if (updates.name !== undefined || updates.description !== undefined || updates.capabilities !== undefined) {
    const baseUrl = new URL(c.req.url).origin
    const caps = parsedCaps ?? safeJsonParse(ep.capabilities, [])
    updates.skillMd = generateSkillMd({
      slug: ep.slug,
      name: (updates.name as string) ?? ep.name,
      description: (updates.description as string | undefined) ?? ep.description,
      capabilities: caps, baseUrl, endpointId: ep.id,
      customDomain: ep.customDomain,
    })
  }

  if (Object.keys(updates).length > 0) {
    await db.update(endpoints).set(updates).where(eq(endpoints.id, ep.id))
  }

  return c.redirect(`/dashboard/agents/${ep.slug}/settings`)
})

// ── Account settings ──

app.get('/dashboard/settings', async (c) => {
  const { userId, userName, plan } = c.get('dashboardAuth')

  const html = dashboardLayout({ title: 'Settings', userName, activePage: 'settings' }, `
    <h1 class="page-title">Account Settings</h1>

    <label class="label">Name</label>
    <div class="card" style="font-size:0.9rem">${esc(userName)}</div>

    <label class="label">Plan</label>
    <div class="card" style="font-size:0.9rem">${esc(plan)}</div>

    <label class="label">User ID</label>
    <div class="card" style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--muted)">${esc(userId)}</div>
  `)

  return c.html(html)
})

export default app
