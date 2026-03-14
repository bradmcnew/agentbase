import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { createSearchClient } from '../services/azure-search'
import { createOpenAIClient } from '../services/azure-openai'
import { chatWithProvider } from '../services/llm-chat'
import { authMiddleware, authWithCredits } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody, safeJsonParse, parseIntParam } from '../utils/validate'
import { signPayload } from '../utils/hmac'
import { QueryEndpointSchema, ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS } from '../types'
import type { Env, AppVariables } from '../types'

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on the provided documents.
Use ONLY the information from the documents below to answer.
If the answer is not found in the documents, say "I don't have information about that in the knowledge base."
Be concise and accurate. Cite which document the information comes from when possible.`

const WEBHOOK_TIMEOUT_MS = 30_000

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// Query an endpoint (THE CORE PRODUCT)
// Rate limit: 60 requests per minute per key (enforced by Unkey)
// Daily quota: 50 queries per day per key (Unkey credits, auto-refills daily)
app.post('/v1/endpoints/:slug/query', authWithCredits, resolveEndpoint as any, async (c) => {
  const startTime = Date.now()
  const ep = c.get('endpoint')

  if (ep.status !== ENDPOINT_STATUS.ACTIVE) {
    return errorResponse(c, 422, ErrorCode.ENDPOINT_PAUSED, 'This endpoint is paused')
  }

  const data = await parseBody(c, QueryEndpointSchema)
  if (data instanceof Response) return data

  try {
    let answer: string
    let sources: Array<{ document: string; content: string; relevance: number }> = []
    let promptTokens = 0
    let completionTokens = 0

    if (ep.mode === ENDPOINT_MODE.EXTERNAL) {
      // ---- EXTERNAL MODE: forward to webhook ----
      if (!ep.webhookUrl) {
        return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'External endpoint has no webhook URL configured')
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
      const webhookBody = JSON.stringify({ query: data.query, context: data.context })

      // Sign the request so customers can verify it came from AgentPort
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (ep.webhookSecret) {
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const signature = await signPayload(`${timestamp}.${webhookBody}`, ep.webhookSecret)
        headers['X-AgentPort-Signature'] = signature
        headers['X-AgentPort-Timestamp'] = timestamp
      }

      try {
        const res = await fetch(ep.webhookUrl, {
          method: 'POST',
          headers,
          body: webhookBody,
          signal: controller.signal,
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
      // ---- PLATFORM / BYOK MODE: RAG pipeline ----
      if (!ep.azureIndexName) {
        return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'Endpoint has no search index')
      }

      const openai = createOpenAIClient(c.env)
      const search = createSearchClient(c.env)

      // 1. Embed the query (always our Azure embedding)
      const queryVector = await openai.embed(data.query)

      // 2. Hybrid search (BM25 + vector + semantic reranking)
      const searchResults = await search.search(ep.azureIndexName, data.query, queryVector, data.max_sources)

      if (searchResults.length === 0) {
        const interactionId = generateId()
        return c.json({
          answer: 'No relevant documents found. Please upload documents to this endpoint first.',
          sources: [], usage: { input_tokens: 0, output_tokens: 0 },
          interaction_id: interactionId,
        })
      }

      // 3. Build context from retrieved chunks
      const context = searchResults
        .map((r, i) => `[Source ${i + 1}: ${r.filename}]\n${r.content}`)
        .join('\n\n---\n\n')

      // 4. Generate answer — routes to correct provider based on mode
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

    // Log interaction (fire and forget)
    c.executionCtx.waitUntil(
      db.insert(interactions).values({
        id: interactionId, endpointId: ep.id,
        query: data.query, response: answer,
        sources: JSON.stringify(sources),
        tokensInput: promptTokens, tokensOutput: completionTokens,
        latencyMs,
      })
    )

    // Add rate limit headers for agent visibility
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

// List interactions
app.get('/v1/endpoints/:slug/interactions', authMiddleware, resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const db = c.get('db')

  const limit = parseIntParam(c.req.query('limit'), 50, 1, 100)
  const offset = parseIntParam(c.req.query('offset'), 0, 0)

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
    interactions: results.map(r => ({
      ...r, sources: safeJsonParse(r.sources, []),
    })),
  })
})

export default app
