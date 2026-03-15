/**
 * Shared query handler used by:
 * - POST /v1/e/{id}/query (public, IP rate limited via CF)
 * - POST /query on custom domains (public, IP rate limited via CF)
 *
 * Daily quota is tracked per-endpoint via D1 counter (atomic reset+increment).
 */

import { Context } from 'hono'
import { interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { createSearchClient } from './azure-search'
import { createOpenAIClient } from './azure-openai'
import { chatWithProvider } from './llm-chat'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { signPayload } from '../utils/hmac'
import { decrypt } from '../utils/encrypt'
import { QueryEndpointSchema, ENDPOINT_STATUS, ENDPOINT_MODE, PLAN_LIMITS } from '../types'
import type { Env } from '../types'
import type { EndpointRow } from '../middleware/resolve-endpoint'

const SYSTEM_PROMPT = `Answer questions using ONLY the provided documents.
Use short sentences. Include specific details: numbers, tool names, exact values.
Do NOT use markdown formatting (bold, italics, headers).
Do NOT cite source documents inline (sources are returned separately in the API response).
Do NOT add disclaimers, caveats, or meta-commentary.
If the answer is not in the documents, respond with exactly: "Not in knowledge base."`

const WEBHOOK_TIMEOUT_MS = 30_000
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function handleQuery(c: Context, ep: EndpointRow): Promise<Response> {
  const env = c.env as Env
  if (ep.status !== ENDPOINT_STATUS.ACTIVE) {
    return errorResponse(c, 422, ErrorCode.ENDPOINT_PAUSED, 'This endpoint is paused')
  }

  const data = await parseBody(c, QueryEndpointSchema)
  if (data instanceof Response) return data

  // --- Daily quota: atomic reset+increment via raw D1 SQL ---
  // Uses raw D1 (not Drizzle) because Drizzle's D1 driver doesn't support RETURNING.
  // The WHERE guard prevents the counter from inflating past the limit on rejected requests.
  const now = Date.now()
  const nextReset = now + QUOTA_WINDOW_MS
  const dailyLimit = PLAN_LIMITS.free.queriesPerDay

  const quotaRow = await env.DB.prepare(`
    UPDATE endpoints
    SET query_count = CASE
      WHEN query_count_reset_at < ?1 THEN 1
      ELSE query_count + 1
    END,
    query_count_reset_at = CASE
      WHEN query_count_reset_at < ?1 THEN ?2
      ELSE query_count_reset_at
    END
    WHERE id = ?3 AND (query_count_reset_at < ?1 OR query_count <= ?4)
    RETURNING query_count, query_count_reset_at
  `).bind(now, nextReset, ep.id, dailyLimit).first<{ query_count: number; query_count_reset_at: number }>()

  if (!quotaRow) {
    // No row returned means either endpoint doesn't exist (shouldn't happen)
    // or the counter already exceeded the limit (WHERE guard filtered it out)
    const retryAfter = Math.max(0, (ep.queryCountResetAt ?? 0) - now)
    c.header('Retry-After', String(Math.ceil(retryAfter / 1000)))
    c.header('X-RateLimit-Limit', String(dailyLimit))
    c.header('X-RateLimit-Remaining', '0')
    c.header('X-RateLimit-Reset', new Date(ep.queryCountResetAt ?? now).toISOString())
    return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED,
      'Daily query limit reached for this endpoint.')
  }

  // Rate limit headers
  const resetAtISO = new Date(quotaRow.query_count_reset_at).toISOString()
  const remaining = dailyLimit - quotaRow.query_count
  c.header('X-RateLimit-Limit', String(dailyLimit))
  c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)))
  c.header('X-RateLimit-Reset', resetAtISO)

  // startTime excludes quota check — measures actual query processing (search + LLM)
  const startTime = Date.now()

  try {
    let answer: string
    let sources: Array<{ document: string; content: string; relevance: number }> = []
    let promptTokens = 0
    let completionTokens = 0

    if (ep.mode === ENDPOINT_MODE.EXTERNAL) {
      // ---- EXTERNAL MODE: OpenAI-compatible chat completions ----
      if (!ep.webhookUrl) {
        return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'External endpoint has no webhook URL configured')
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)

      const systemPrompt = ep.systemPrompt || SYSTEM_PROMPT
      const userContent = data.context ? `${data.context}\n\n${data.query}` : data.query
      const webhookBody = JSON.stringify({
        model: ep.externalModel || 'default',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      })

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (ep.externalApiKey) {
        const apiKey = await decrypt(ep.externalApiKey, env.ENCRYPTION_SECRET)
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      if (ep.webhookSecret) {
        const secret = await decrypt(ep.webhookSecret, env.ENCRYPTION_SECRET)
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const signature = await signPayload(`${timestamp}.${webhookBody}`, secret)
        headers['X-AgentPort-Signature'] = signature
        headers['X-AgentPort-Timestamp'] = timestamp
      }

      try {
        const res = await fetch(ep.webhookUrl, {
          method: 'POST', headers, body: webhookBody, signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!res.ok) {
          const body = (await res.text()).slice(0, 200)
          throw new Error(`Webhook returned ${res.status}: ${body}`)
        }

        const webhookData = await res.json() as {
          choices?: Array<{ message: { content: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }

        answer = webhookData.choices?.[0]?.message?.content || ''
        promptTokens = webhookData.usage?.prompt_tokens || 0
        completionTokens = webhookData.usage?.completion_tokens || 0
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

      const openai = createOpenAIClient(env)
      const search = createSearchClient(env)

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

      const llmResult = await chatWithProvider(ep, env, systemPrompt, context, queryText)

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

    return c.json({
      answer, sources,
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      interaction_id: interactionId,
    })
  } catch (err) {
    // Surface upstream provider errors (e.g., "LLM API error 401: Invalid API key")
    // so agents can self-diagnose BYOK key issues, webhook failures, etc.
    const msg = err instanceof Error ? err.message : ''
    const upstreamMatch = msg.match(/^(LLM API|Anthropic API|Webhook).*?(\d{3})/)
    const userMessage = upstreamMatch
      ? `Query failed: upstream returned ${upstreamMatch[2]}. Check your API key or webhook configuration.`
      : 'Failed to process query. Please try again.'
    return serviceError(c, ErrorCode.QUERY_ERROR, userMessage, err)
  }
}
