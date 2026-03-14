import { Hono } from 'hono'
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

  try {
    const chunks = chunkText(data.content)
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
