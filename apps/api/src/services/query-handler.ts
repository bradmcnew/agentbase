/**
 * Shared query handler used by:
 * - POST /v1/e/{id}/query (public, IP rate limited via CF)
 * - POST /query on custom domains (public, IP rate limited via CF)
 *
 * Daily quota is tracked per-endpoint via D1 counter (atomic reset+increment).
 */

import { Context } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { signPayload } from '../utils/hmac'
import { decrypt } from '../utils/encrypt'
import { QueryEndpointSchema, ENDPOINT_STATUS, PLAN_LIMITS, CONFIDENCE } from '../types'
import type { Env } from '../types'
import type { EndpointRow } from '../middleware/resolve-endpoint'

const CONFIDENCE_TAG_RE = new RegExp(
  `\\n?\\[CONFIDENCE:(${CONFIDENCE.CONFIDENT}|${CONFIDENCE.REVIEW}|${CONFIDENCE.NOT_FOUND})\\|SOURCES:([^\\]]*)\\]\\s*$`
)

function parseConfidenceTag(raw: string): { answer: string; confidence: string | null; sources: string | null } {
  const match = raw.match(CONFIDENCE_TAG_RE)
  if (!match) return { answer: raw, confidence: null, sources: null }
  const sources = match[2] === 'none' ? null : match[2]
  return { answer: raw.slice(0, match.index!).trimEnd(), confidence: match[1], sources }
}

const WEBHOOK_TIMEOUT_MS = 60_000
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_HISTORY_TURNS = 5
const MAX_HISTORY_CHARS = 8000

export async function handleQuery(c: Context, ep: EndpointRow): Promise<Response> {
  const env = c.env as Env
  if (ep.status !== ENDPOINT_STATUS.ACTIVE) {
    return errorResponse(c, 422, ErrorCode.ENDPOINT_PAUSED, 'This endpoint is paused')
  }

  const data = await parseBody(c, QueryEndpointSchema)
  if (data instanceof Response) return data

  // --- Daily quota: atomic reset+increment via raw D1 SQL ---
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
    const retryAfter = Math.max(0, (ep.queryCountResetAt ?? 0) - now)
    c.header('Retry-After', String(Math.ceil(retryAfter / 1000)))
    c.header('X-RateLimit-Limit', String(dailyLimit))
    c.header('X-RateLimit-Remaining', '0')
    c.header('X-RateLimit-Reset', new Date(ep.queryCountResetAt ?? now).toISOString())
    return errorResponse(c, 429, ErrorCode.QUOTA_EXCEEDED,
      'Daily query limit reached for this endpoint.')
  }

  const resetAtISO = new Date(quotaRow.query_count_reset_at).toISOString()
  const remaining = dailyLimit - quotaRow.query_count
  c.header('X-RateLimit-Limit', String(dailyLimit))
  c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)))
  c.header('X-RateLimit-Reset', resetAtISO)

  const startTime = Date.now()

  try {
    if (!ep.webhookUrl) {
      return errorResponse(c, 422, ErrorCode.QUERY_ERROR, 'Endpoint has no webhook URL configured')
    }

    const db = c.get('db')
    const conversationId = data.conversation_id || null

    // Load history + decrypt keys in parallel
    const [history, apiKey, webhookSecretKey] = await Promise.all([
      data.conversation_id
        ? db.select({ query: interactions.query, response: interactions.response })
            .from(interactions)
            .where(eq(interactions.conversationId, data.conversation_id))
            .orderBy(desc(interactions.createdAt))
            .limit(MAX_HISTORY_TURNS)
            .then((rows: Array<{ query: string; response: string }>) => rows.reverse())
        : Promise.resolve([]),
      ep.externalApiKey ? decrypt(ep.externalApiKey, env.ENCRYPTION_SECRET) : null,
      ep.webhookSecret ? decrypt(ep.webhookSecret, env.ENCRYPTION_SECRET) : null,
    ])

    const messages: Array<{ role: string; content: string }> = []
    if (ep.systemPrompt) messages.push({ role: 'system', content: ep.systemPrompt })
    let historyChars = 0
    for (const turn of history) {
      const turnChars = turn.query.length + turn.response.length
      if (historyChars + turnChars > MAX_HISTORY_CHARS) break
      messages.push({ role: 'user', content: turn.query })
      messages.push({ role: 'assistant', content: turn.response })
      historyChars += turnChars
    }
    const userContent = data.context ? `${data.context}\n\n${data.query}` : data.query
    messages.push({ role: 'user', content: userContent })

    const webhookBody = JSON.stringify({
      model: ep.externalModel || 'default',
      messages,
    })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    if (webhookSecretKey) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = await signPayload(`${timestamp}.${webhookBody}`, webhookSecretKey)
      headers['X-AgentPort-Signature'] = signature
      headers['X-AgentPort-Timestamp'] = timestamp
    }

    let answer: string
    let confidence: string | null = null
    let confidenceSources: string | null = null
    let promptTokens = 0
    let completionTokens = 0

    try {
      const res = await fetch(ep.webhookUrl, {
        method: 'POST', headers, body: webhookBody,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })

      if (!res.ok) {
        const body = (await res.text()).slice(0, 200)
        throw new Error(`Webhook returned ${res.status}: ${body}`)
      }

      const webhookData = await res.json() as {
        choices?: Array<{ message: { content: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const rawAnswer = webhookData.choices?.[0]?.message?.content || ''
      const parsed = parseConfidenceTag(rawAnswer)
      answer = parsed.answer
      confidence = parsed.confidence
      confidenceSources = parsed.sources
      promptTokens = webhookData.usage?.prompt_tokens || 0
      completionTokens = webhookData.usage?.completion_tokens || 0
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('Webhook timed out after 60 seconds')
      }
      throw err
    }

    const latencyMs = Date.now() - startTime
    const interactionId = generateId()

    c.executionCtx.waitUntil(
      db.insert(interactions).values({
        id: interactionId, endpointId: ep.id,
        query: data.query, response: answer,
        tokensInput: promptTokens, tokensOutput: completionTokens,
        latencyMs, confidence, confidenceSources, conversationId,
      })
    )

    const response: Record<string, unknown> = { answer }
    if (conversationId) response.conversation_id = conversationId
    if (confidence) response.confidence = confidence
    return c.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    const upstreamMatch = msg.match(/^Webhook.*?(\d{3})/)
    const userMessage = upstreamMatch
      ? `Query failed: upstream returned ${upstreamMatch[1]}. Check your webhook configuration.`
      : 'Failed to process query. Please try again.'
    return serviceError(c, ErrorCode.QUERY_ERROR, userMessage, err)
  }
}
