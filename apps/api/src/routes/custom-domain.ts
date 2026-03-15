/**
 * Custom domain routing: when a request arrives on a customer's domain
 * (e.g., docs.acme.com), route it to the right endpoint.
 *
 * Simplified URL structure on custom domains:
 *   GET  /skill.md        → endpoint's SKILL.md
 *   GET  /llms.txt        → endpoint's llms.txt
 *   POST /query           → query the endpoint
 *   GET  /docs            → list documents
 *   POST /docs            → upload document
 *   DELETE /docs/:filename → delete document
 *   GET  /interactions    → list interactions
 */

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { endpoints, interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { chunkText } from '../utils/chunker'
import { extractText } from 'unpdf'
import { createSearchClient } from '../services/azure-search'
import { createOpenAIClient } from '../services/azure-openai'
import { chatWithProvider } from '../services/llm-chat'
import { generateLlmsTxt } from '../services/skill-gen'
import { authMiddleware, authWithCredits } from '../middleware/auth'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody, safeJsonParse, parseIntParam } from '../utils/validate'
import { signPayload } from '../utils/hmac'
import { UploadDocumentSchema, QueryEndpointSchema, ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS } from '../types'
import type { Env, AppVariables } from '../types'
import type { EndpointRow } from '../middleware/resolve-endpoint'

const PLATFORM_HOSTNAME = 'agentbase.axite.ai'
const EMBED_BATCH_SIZE = 16
const WEBHOOK_TIMEOUT_MS = 30_000

const SYSTEM_PROMPT = `Answer questions using ONLY the provided documents.
Use short sentences. Include specific details: numbers, tool names, exact values.
Do NOT use markdown formatting (bold, italics, headers).
Do NOT cite source documents inline (sources are returned separately in the API response).
Do NOT add disclaimers, caveats, or meta-commentary.
If the answer is not in the documents, respond with exactly: "Not in knowledge base."`

const app = new Hono<{ Bindings: Env; Variables: AppVariables & { customEndpoint: EndpointRow } }>()

/**
 * Middleware: resolve endpoint by hostname.
 * Only runs for non-platform hostnames.
 */
async function resolveByHostname(c: any, next: any) {
  const hostname = new URL(c.req.url).hostname
  if (hostname === PLATFORM_HOSTNAME || hostname.endsWith('.workers.dev')) {
    return // Platform request -- skip, let standard routes handle it
  }

  const db = c.get('db')
  let ep

  // Check custom domain first (takes priority)
  ;[ep] = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.customDomain, hostname))
    .limit(1)

  // Then check wildcard subdomain (e.g., acme.agentbase.axite.ai -> slug "acme")
  if (!ep && hostname.endsWith('.agentbase.axite.ai')) {
    const slug = hostname.split('.')[0]
    ;[ep] = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.slug, slug))
      .limit(1)
  }

  if (!ep || ep.status === ENDPOINT_STATUS.ARCHIVED) {
    return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'No endpoint configured for this domain')
  }

  c.set('endpoint', ep)
  await next()
}

// --- Public routes (no auth) ---

app.get('/skill.md', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return // Not a custom domain
  if (!ep.skillMd) return errorResponse(c, 404, ErrorCode.NOT_FOUND, 'SKILL.md not generated yet')

  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(ep.skillMd)
})

app.get('/llms.txt', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  const baseUrl = `https://${ep.customDomain}`
  const llmsTxt = generateLlmsTxt({
    slug: ep.slug, name: ep.name, description: ep.description,
    capabilities: safeJsonParse(ep.capabilities, []),
    baseUrl, endpointId: ep.id,
  })

  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  return c.text(llmsTxt)
})

// --- Authenticated routes ---

app.post('/query', resolveByHostname, authWithCredits, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  if (ep.status !== ENDPOINT_STATUS.ACTIVE) {
    return errorResponse(c, 422, ErrorCode.ENDPOINT_PAUSED, 'This endpoint is paused')
  }

  const data = await parseBody(c, QueryEndpointSchema)
  if (data instanceof Response) return data

  const startTime = Date.now()

  try {
    let answer: string
    let sources: Array<{ document: string; content: string; relevance: number }> = []
    let promptTokens = 0
    let completionTokens = 0

    if (ep.mode === ENDPOINT_MODE.EXTERNAL) {
      if (!ep.webhookUrl) {
        return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'External endpoint has no webhook URL configured')
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
      const webhookBody = JSON.stringify({ query: data.query, context: data.context })

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (ep.webhookSecret) {
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const signature = await signPayload(`${timestamp}.${webhookBody}`, ep.webhookSecret)
        headers['X-AgentPort-Signature'] = signature
        headers['X-AgentPort-Timestamp'] = timestamp
      }

      try {
        const res = await fetch(ep.webhookUrl, {
          method: 'POST', headers, body: webhookBody, signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!res.ok) {
          const body = await res.text()
          throw new Error(`Webhook returned ${res.status}: ${body}`)
        }

        const webhookData = await res.json() as {
          answer?: string
          sources?: Array<{ document: string; content: string; relevance?: number }>
          usage?: { input_tokens?: number; output_tokens?: number }
        }

        answer = webhookData.answer || ''
        sources = (webhookData.sources || []).map(s => ({
          document: s.document, content: s.content, relevance: s.relevance || 0,
        }))
        promptTokens = webhookData.usage?.input_tokens || 0
        completionTokens = webhookData.usage?.output_tokens || 0
      } catch (err) {
        clearTimeout(timeout)
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Webhook timed out after 30 seconds')
        }
        throw err
      }
    } else {
      if (!ep.azureIndexName) {
        return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'Endpoint has no search index')
      }

      const openai = createOpenAIClient(c.env)
      const search = createSearchClient(c.env)
      const queryVector = await openai.embed(data.query)
      const searchResults = await search.search(ep.azureIndexName, data.query, queryVector, data.max_sources)

      if (searchResults.length === 0) {
        return c.json({
          answer: 'No relevant documents found. Please upload documents to this endpoint first.',
          sources: [], usage: { input_tokens: 0, output_tokens: 0 },
          interaction_id: generateId(),
        })
      }

      const context = searchResults
        .map((r, i) => `[Source ${i + 1}: ${r.filename}]\n${r.content}`)
        .join('\n\n---\n\n')

      const systemPrompt = ep.systemPrompt || SYSTEM_PROMPT
      const queryText = data.context
        ? `Additional context: ${data.context}\n\nQuestion: ${data.query}`
        : data.query

      const llmResult = await chatWithProvider(ep, c.env, systemPrompt, context, queryText)

      answer = llmResult.answer
      sources = searchResults.map(r => ({
        document: r.filename,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
        relevance: r.score,
      }))
      promptTokens = llmResult.promptTokens
      completionTokens = llmResult.completionTokens
    }

    const latencyMs = Date.now() - startTime
    const interactionId = generateId()
    const db = c.get('db')

    c.executionCtx.waitUntil(
      db.insert(interactions).values({
        id: interactionId, endpointId: ep.id,
        query: data.query, response: answer,
        sources: JSON.stringify(sources),
        tokensInput: promptTokens, tokensOutput: completionTokens,
        latencyMs,
      })
    )

    const remaining = c.get('remainingCredits')
    if (remaining !== undefined) {
      const tomorrow = new Date()
      tomorrow.setUTCHours(24, 0, 0, 0)
      c.header('X-RateLimit-Limit', String(PLAN_LIMITS.free.queriesPerDay))
      c.header('X-RateLimit-Remaining', String(remaining))
      c.header('X-RateLimit-Reset', tomorrow.toISOString())
    }

    return c.json({
      answer, sources,
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      interaction_id: interactionId,
    })
  } catch (err) {
    return serviceError(c, ErrorCode.QUERY_ERROR, 'Failed to process query. Please try again.', err)
  }
})

app.get('/docs', resolveByHostname, authMiddleware, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  if (!ep.azureIndexName) return c.json({ documents: [] })

  const search = createSearchClient(c.env)
  try {
    const docs = await search.listDocuments(ep.azureIndexName)
    const fileMap = new Map<string, number>()
    for (const doc of docs) {
      fileMap.set(doc.filename, (fileMap.get(doc.filename) || 0) + 1)
    }
    return c.json({
      documents: Array.from(fileMap.entries()).map(([filename, chunkCount]) => ({
        filename, chunk_count: chunkCount, status: 'indexed',
      })),
    })
  } catch (err) {
    return serviceError(c, ErrorCode.SEARCH_ERROR, 'Failed to list documents.', err)
  }
})

app.post('/docs', resolveByHostname, authMiddleware, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  if (ep.mode === ENDPOINT_MODE.EXTERNAL) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR,
      'External endpoints don\'t support document uploads.')
  }

  if (!ep.azureIndexName) {
    return errorResponse(c, 422, ErrorCode.SEARCH_ERROR, 'Endpoint has no search index')
  }

  const data = await parseBody(c, UploadDocumentSchema)
  if (data instanceof Response) return data

  const openai = createOpenAIClient(c.env)
  const search = createSearchClient(c.env)

  let textContent = data.content
  if (data.pdf) {
    try {
      const pdfBytes = Uint8Array.from(atob(data.pdf), byte => byte.charCodeAt(0))
      const { text } = await extractText(pdfBytes, { mergePages: true })
      textContent = text
    } catch (err) {
      console.error('PDF parse error:', err instanceof Error ? err.message : err)
      return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Failed to parse PDF.')
    }
  }

  if (!textContent || textContent.trim().length === 0) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'No text could be extracted.')
  }

  try {
    const chunks = chunkText(textContent)
    const docId = generateId()
    const allVectors: number[][] = []

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE)
      const vectors = await openai.embedBatch(batch.map(ch => ch.content))
      allVectors.push(...vectors)
    }

    const docsToUpload = chunks.map((chunk, i) => ({
      id: `${docId}-${chunk.index}`, content: chunk.content,
      contentVector: allVectors[i], filename: data.filename, chunkIndex: chunk.index,
    }))

    const result = await search.uploadDocuments(ep.azureIndexName, docsToUpload)

    return c.json({
      document: {
        id: docId, filename: data.filename, chunk_count: chunks.length,
        status: result.failed === 0 ? 'indexed' : 'partial',
        succeeded: result.succeeded, failed: result.failed,
      },
    }, 201)
  } catch (err) {
    return serviceError(c, ErrorCode.INDEXING_ERROR, 'Failed to index document.', err)
  }
})

app.delete('/docs/:filename', resolveByHostname, authMiddleware, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  const filename = decodeURIComponent(c.req.param('filename') || '')

  if (!ep.azureIndexName) {
    return errorResponse(c, 422, ErrorCode.SEARCH_ERROR, 'Endpoint has no search index')
  }

  const search = createSearchClient(c.env)
  try {
    const matching = await search.listDocuments(ep.azureIndexName, filename)
    if (matching.length === 0) {
      return errorResponse(c, 404, ErrorCode.NOT_FOUND, `No document found with filename "${filename}"`)
    }
    const { deleted } = await search.deleteDocuments(ep.azureIndexName, matching.map(d => d.id))
    return c.json({ deleted: { filename, chunks_removed: deleted } })
  } catch (err) {
    return serviceError(c, ErrorCode.SEARCH_ERROR, 'Failed to delete document.', err)
  }
})

app.get('/interactions', resolveByHostname, authMiddleware, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  const db = c.get('db')
  const limit = parseIntParam(c.req.query('limit'), 50, 1, 100)
  const offset = parseIntParam(c.req.query('offset'), 0, 0)

  const { desc } = await import('drizzle-orm')
  const results = await db
    .select({
      id: interactions.id, query: interactions.query, response: interactions.response,
      sources: interactions.sources, tokensInput: interactions.tokensInput,
      tokensOutput: interactions.tokensOutput, latencyMs: interactions.latencyMs,
      createdAt: interactions.createdAt,
    })
    .from(interactions)
    .where(eq(interactions.endpointId, ep.id))
    .orderBy(desc(interactions.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    interactions: results.map(r => ({ ...r, sources: safeJsonParse(r.sources, []) })),
  })
})

export default app
