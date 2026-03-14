import { Hono } from 'hono'
import { extractText } from 'unpdf'
import { generateId } from '../utils/id'
import { chunkText } from '../utils/chunker'
import { createSearchClient } from '../services/azure-search'
import { createOpenAIClient } from '../services/azure-openai'
import { authMiddleware } from '../middleware/auth'
import { resolveEndpoint } from '../middleware/resolve-endpoint'
import { errorResponse, serviceError, ErrorCode } from '../utils/errors'
import { parseBody } from '../utils/validate'
import { UploadDocumentSchema, ENDPOINT_MODE } from '../types'
import type { Env, AppVariables } from '../types'

const EMBED_BATCH_SIZE = 16

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

app.use('*', authMiddleware)

// Upload document to endpoint
app.post('/v1/endpoints/:slug/docs', resolveEndpoint as any, async (c) => {
  const data = await parseBody(c, UploadDocumentSchema)
  if (data instanceof Response) return data

  const ep = c.get('endpoint')

  if (ep.mode === ENDPOINT_MODE.EXTERNAL) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR,
      'External endpoints don\'t support document uploads. Queries are forwarded to your agent.')
  }

  if (!ep.azureIndexName) {
    return errorResponse(c, 422, ErrorCode.SEARCH_ERROR, 'Endpoint has no search index')
  }

  const openai = createOpenAIClient(c.env)
  const search = createSearchClient(c.env)

  // Extract text from PDF or use provided content
  let textContent = data.content
  if (data.pdf) {
    try {
      const pdfBytes = Uint8Array.from(atob(data.pdf), byte => byte.charCodeAt(0))
      const { text } = await extractText(pdfBytes, { mergePages: true })
      textContent = text
    } catch (err) {
      console.error('PDF parse error:', err instanceof Error ? err.message : err)
      return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR, 'Failed to parse PDF. Ensure the file is a valid PDF.')
    }
  }

  if (!textContent || textContent.trim().length === 0) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR,
      'No text could be extracted. For scanned/image-only PDFs, convert to text first.')
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
      id: `${docId}-${chunk.index}`,
      content: chunk.content,
      contentVector: allVectors[i],
      filename: data.filename,
      chunkIndex: chunk.index,
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
    return serviceError(c, ErrorCode.INDEXING_ERROR, 'Failed to index document. Please try again.', err)
  }
})

// Delete document by filename
app.delete('/v1/endpoints/:slug/docs/:filename', resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')
  const filename = decodeURIComponent(c.req.param('filename'))

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

// List documents for endpoint
app.get('/v1/endpoints/:slug/docs', resolveEndpoint as any, async (c) => {
  const ep = c.get('endpoint')

  if (!ep.azureIndexName) {
    return c.json({ documents: [] })
  }

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

export default app
