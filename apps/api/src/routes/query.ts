import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { createSearchClient } from '../services/azure-search'
import { createOpenAIClient } from '../services/azure-openai'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody, safeJsonParse, parseIntParam } from '../utils/validate'
import { QueryEndpointSchema, ENDPOINT_STATUS } from '../types'
import type { Env, AppVariables } from '../types'

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on the provided documents.
Use ONLY the information from the documents below to answer.
If the answer is not found in the documents, say "I don't have information about that in the knowledge base."
Be concise and accurate. Cite which document the information comes from when possible.`

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('*', authMiddleware)

// Query an endpoint (THE CORE PRODUCT)
app.post('/v1/endpoints/:slug/query', resolveEndpoint as any, async (c) => {
  const startTime = Date.now()
  const ep = c.get('endpoint')

  if (ep.status !== ENDPOINT_STATUS.ACTIVE) {
    return errorResponse(c, 422, ErrorCode.ENDPOINT_PAUSED, 'This endpoint is paused')
  }

  const data = await parseBody(c, QueryEndpointSchema)
  if (data instanceof Response) return data

  const openai = createOpenAIClient(c.env)
  const search = createSearchClient(c.env)

  try {
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

    const llmResult = await openai.chat(systemPrompt, context, queryText)
    const latencyMs = Date.now() - startTime

    const sources = searchResults.map(r => ({
      document: r.filename,
      content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      relevance: r.score,
    }))

    const interactionId = generateId()
    const db = c.get('db')

    c.executionCtx.waitUntil(
      db.insert(interactions).values({
        id: interactionId, endpointId: ep.id,
        query: data.query, response: llmResult.answer,
        sources: JSON.stringify(sources),
        tokensInput: llmResult.promptTokens, tokensOutput: llmResult.completionTokens,
        latencyMs,
      })
    )

    return c.json({
      answer: llmResult.answer, sources,
      usage: { input_tokens: llmResult.promptTokens, output_tokens: llmResult.completionTokens },
      interaction_id: interactionId,
    })
  } catch (err) {
    return serviceError(c, ErrorCode.QUERY_ERROR, 'Failed to process query. Please try again.', err)
  }
})

// List interactions
app.get('/v1/endpoints/:slug/interactions', resolveEndpoint as any, async (c) => {
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
