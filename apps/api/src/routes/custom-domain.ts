/**
 * Custom domain routing: when a request arrives on a customer's domain
 * (e.g., docs.acme.com), route it to the right endpoint.
 *
 * Simplified URL structure on custom domains:
 *   GET  /skill.md        → endpoint's SKILL.md
 *   GET  /llms.txt        → endpoint's llms.txt
 *   POST /query           → query the endpoint (public, IP rate limited)
 *   GET  /docs            → list documents
 *   POST /docs            → upload document
 *   DELETE /docs/:filename → delete document
 *   GET  /interactions    → list interactions
 */

import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { endpoints, interactions } from '../db/schema'
import { generateId } from '../utils/id'
import { chunkText } from '../utils/chunker'
import { extractText } from 'unpdf'
import { createSearchClient } from '../services/azure-search'
import { createOpenAIClient } from '../services/azure-openai'
import { handleQuery } from '../services/query-handler'
import { generateLlmsTxt } from '../services/skill-gen'
import { authMiddleware } from '../middleware/auth'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody, safeJsonParse, parseIntParam } from '../utils/validate'
import { UploadDocumentSchema, ENDPOINT_STATUS, ENDPOINT_MODE } from '../types'
import type { Env, AppVariables } from '../types'
import type { EndpointRow } from '../middleware/resolve-endpoint'

const PLATFORM_HOSTNAME = 'agentbase.axite.ai'
const EMBED_BATCH_SIZE = 16

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
  const [ep] = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.customDomain, hostname))
    .limit(1)

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

// Public: Query via custom domain (no auth, daily quota via D1, IP rate limited via CF)
app.post('/query', resolveByHostname, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

  return handleQuery(c, ep)
})

// --- Authenticated routes ---

/** Verify the authenticated account owns the endpoint resolved by hostname */
async function verifyOwnership(c: any, next: any) {
  const ep = c.get('endpoint')
  const auth = c.get('auth')
  if (!ep || !auth) return
  if (ep.accountId !== auth.accountId) {
    return errorResponse(c, 403, ErrorCode.UNAUTHORIZED, 'Not authorized for this endpoint')
  }
  return next()
}

app.get('/docs', resolveByHostname, authMiddleware, verifyOwnership, async (c) => {
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

app.post('/docs', resolveByHostname, authMiddleware, verifyOwnership, async (c) => {
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

app.delete('/docs/:filename', resolveByHostname, authMiddleware, verifyOwnership, async (c) => {
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

app.get('/interactions', resolveByHostname, authMiddleware, verifyOwnership, async (c) => {
  const ep = c.get('endpoint')
  if (!ep) return

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
    interactions: results.map(r => ({ ...r, sources: safeJsonParse(r.sources, []) })),
  })
})

export default app
