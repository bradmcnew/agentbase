/**
 * Azure AI Search client for index management, document upload, and hybrid search.
 *
 * Standard tier with semantic ranking enabled.
 * Hybrid search: BM25 + vector (HNSW) + semantic reranking.
 *
 * API version: 2024-07-01 (latest stable)
 * Docs: https://learn.microsoft.com/en-us/rest/api/searchservice/
 */

interface AzureSearchConfig {
  endpoint: string  // https://[name].search.windows.net
  apiKey: string    // Admin API key
}

const API_VERSION = '2024-07-01'

interface SearchResult {
  id: string
  content: string
  filename: string
  chunkIndex: number
  score: number
}

export class AzureSearchClient {
  private endpoint: string
  private apiKey: string

  constructor(config: AzureSearchConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '')
    this.apiKey = config.apiKey
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.endpoint}${path}${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`
    const res = await fetch(url, {
      ...options,
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Azure Search error ${res.status}: ${body}`)
    }

    return res.json() as Promise<T>
  }

  /**
   * Create a search index for an endpoint.
   * Hybrid search: BM25 full-text on `content` + HNSW vector on `contentVector`.
   * Semantic ranking reranks results for higher quality.
   * Results merged via Reciprocal Rank Fusion (RRF).
   */
  async createIndex(indexName: string, dimensions: number = 1536): Promise<void> {
    await this.request(`/indexes/${indexName}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: indexName,
        fields: [
          { name: 'id', type: 'Edm.String', key: true, filterable: true, searchable: true, retrievable: true },
          { name: 'content', type: 'Edm.String', searchable: true, retrievable: true },
          {
            name: 'contentVector',
            type: 'Collection(Edm.Single)',
            searchable: true,
            retrievable: false,
            stored: false,
            dimensions,
            vectorSearchProfile: 'default-profile',
          },
          { name: 'filename', type: 'Edm.String', searchable: true, filterable: true, retrievable: true },
          { name: 'chunkIndex', type: 'Edm.Int32', filterable: true, retrievable: true },
        ],
        vectorSearch: {
          algorithms: [
            {
              name: 'hnsw-algo',
              kind: 'hnsw',
              hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' },
            },
          ],
          profiles: [
            { name: 'default-profile', algorithm: 'hnsw-algo' },
          ],
        },
        semantic: {
          defaultConfiguration: 'default-semantic',
          configurations: [
            {
              name: 'default-semantic',
              prioritizedFields: {
                prioritizedContentFields: [{ fieldName: 'content' }],
              },
            },
          ],
        },
      }),
    })
  }

  /** Upload document chunks with vectors to the index. Max 1000 docs per batch. */
  async uploadDocuments(
    indexName: string,
    docs: Array<{ id: string; content: string; contentVector: number[]; filename: string; chunkIndex: number }>
  ): Promise<{ succeeded: number; failed: number }> {
    const result = await this.request<{ value: Array<{ key: string; status: boolean; statusCode: number }> }>(
      `/indexes/${indexName}/docs/index`,
      {
        method: 'POST',
        body: JSON.stringify({
          value: docs.map(doc => ({
            '@search.action': 'upload',
            ...doc,
          })),
        }),
      }
    )

    const succeeded = result.value.reduce((n, r) => n + (r.status ? 1 : 0), 0)
    return { succeeded, failed: result.value.length - succeeded }
  }

  /**
   * Hybrid search with semantic reranking.
   *
   * 1. BM25 full-text search on `content`
   * 2. HNSW vector search on `contentVector`
   * 3. Reciprocal Rank Fusion merges both result sets
   * 4. Semantic ranker reranks the fused results for quality
   *
   * Note: RRF scores are low by nature (0.01–0.05 is a good match).
   */
  async search(indexName: string, query: string, queryVector: number[], topK: number = 5): Promise<SearchResult[]> {
    const result = await this.request<{ value: Array<{ '@search.score': number; '@search.rerankerScore'?: number; id: string; content: string; filename: string; chunkIndex: number }> }>(
      `/indexes/${indexName}/docs/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          search: query,
          queryType: 'semantic',
          semanticConfiguration: 'default-semantic',
          vectorQueries: [
            {
              vector: queryVector,
              fields: 'contentVector',
              kind: 'vector',
              exhaustive: true,
              k: Math.max(topK, 50),  // Retrieve more for semantic reranking
            },
          ],
          select: 'id,content,filename,chunkIndex',
          top: topK,
        }),
      }
    )

    return result.value.map(r => ({
      id: r.id,
      content: r.content,
      filename: r.filename,
      chunkIndex: r.chunkIndex,
      score: r['@search.rerankerScore'] ?? r['@search.score'],
    }))
  }

  /** Delete an index entirely. */
  async deleteIndex(indexName: string): Promise<void> {
    await this.request(`/indexes/${indexName}`, { method: 'DELETE' })
  }

  /** List documents in an index. */
  async listDocuments(indexName: string): Promise<Array<{ id: string; filename: string; chunkIndex: number }>> {
    const result = await this.request<{ value: Array<{ id: string; filename: string; chunkIndex: number }> }>(
      `/indexes/${indexName}/docs?$select=id,filename,chunkIndex&$top=1000`
    )
    return result.value
  }

  /** Generate the Azure index name for an endpoint */
  static indexName(accountId: string, slug: string): string {
    return `ep-${accountId.slice(0, 8)}-${slug}`
  }
}

/** Factory: create client from Env bindings */
export function createSearchClient(env: { AZURE_SEARCH_ENDPOINT: string; AZURE_SEARCH_API_KEY: string }) {
  return new AzureSearchClient({ endpoint: env.AZURE_SEARCH_ENDPOINT, apiKey: env.AZURE_SEARCH_API_KEY })
}
