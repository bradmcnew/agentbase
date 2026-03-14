/**
 * Azure OpenAI client for embeddings and chat completion.
 */

interface AzureOpenAIConfig {
  endpoint: string
  apiKey: string
  embeddingDeployment: string
  chatDeployment: string
}

const API_VERSION = '2024-06-01'

export class AzureOpenAIClient {
  private endpoint: string
  private apiKey: string
  private embeddingDeployment: string
  private chatDeployment: string

  constructor(config: AzureOpenAIConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.embeddingDeployment = config.embeddingDeployment
    this.chatDeployment = config.chatDeployment
  }

  /** Generate embedding vector for a single text string */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]
  }

  /** Generate embeddings for multiple texts in a single API call (max ~16 per batch) */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${this.endpoint}/openai/deployments/${this.embeddingDeployment}/embeddings?api-version=${API_VERSION}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Azure OpenAI embedding error ${res.status}: ${body}`)
    }

    const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> }
    // Sort by index to ensure order matches input
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
  }

  /** Generate chat completion with context. modelOverride selects a different Azure deployment. */
  async chat(systemPrompt: string, context: string, query: string, modelOverride?: string): Promise<{ answer: string; promptTokens: number; completionTokens: number }> {
    const deployment = modelOverride || this.chatDeployment
    const url = `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${context}\n\n---\n\nQuestion: ${query}` },
        ],
        max_completion_tokens: 1024,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Azure OpenAI chat error ${res.status}: ${body}`)
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      answer: data.choices[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    }
  }
}

/** Factory: create client from Env bindings */
export function createOpenAIClient(env: { AZURE_OPENAI_ENDPOINT: string; AZURE_OPENAI_API_KEY: string; AZURE_OPENAI_EMBEDDING_DEPLOYMENT: string; AZURE_OPENAI_CHAT_DEPLOYMENT: string }) {
  return new AzureOpenAIClient({
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    apiKey: env.AZURE_OPENAI_API_KEY,
    embeddingDeployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    chatDeployment: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
  })
}
