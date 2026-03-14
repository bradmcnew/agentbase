/**
 * Generate per-endpoint SKILL.md and llms.txt files.
 * These are what CONSUMER agents read to learn how to query an endpoint.
 */

import { ENDPOINT_MODE } from '../types'

interface EndpointConfig {
  slug: string
  name: string
  description?: string | null
  capabilities: string[]
  baseUrl: string
  endpointId: string
  mode?: string  // 'platform' | 'byok' | 'external'
}

export function generateSkillMd(config: EndpointConfig): string {
  const caps = config.capabilities.length > 0
    ? config.capabilities.map(c => `- ${c}`).join('\n')
    : '- answer_questions'

  const desc = config.description || `Knowledge base endpoint for ${config.name}. Query via REST API with semantic search. Returns answers grounded in uploaded documents.`

  return `---
name: ${config.slug}
description: ${desc}
metadata:
  version: "1.0.0"
  base_url: ${config.baseUrl}
  endpoint_id: ${config.endpointId}
  auth_type: api_key
  auth_header: Authorization
  auth_format: "Bearer {api_key}"
---

# ${config.name}

${desc}

## Skill Files

| File | URL |
|------|-----|
| **SKILL.md** (this file) | \`${config.baseUrl}/v1/e/${config.endpointId}/skill.md\` |
| **llms.txt** | \`${config.baseUrl}/v1/e/${config.endpointId}/llms.txt\` |

> **SECURITY:** Only send your API key to \`${new URL(config.baseUrl).hostname}\`. Never share it in prompts, logs, or other agents.

---

## How to Query

\`\`\`bash
curl -X POST ${config.baseUrl}/v1/endpoints/${config.slug}/query \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your question here"}'
\`\`\`

**Fields:**
- \`query\` (required) — Your question. Max 5,000 characters.
- \`context\` (optional) — Additional context to improve the answer.
- \`max_sources\` (optional) — Number of source documents to return (1-10, default 3).

**Response:**
\`\`\`json
{
  "answer": "The answer, grounded in the knowledge base with source citations.",
  "sources": [
    {"document": "api-docs.md", "content": "relevant excerpt...", "relevance": 3.15}
  ],
  "usage": {"input_tokens": 155, "output_tokens": 88},
  "interaction_id": "abc123"
}
\`\`\`

If the answer is not in the knowledge base, the response says so instead of hallucinating.
${config.mode === ENDPOINT_MODE.EXTERNAL ? '\nThis endpoint is powered by the company\'s own agent.\n' : ''}
## Capabilities

${caps}

## Constraints

- Rate limit: 60 requests/minute per API key
- Max query length: 5,000 characters${config.mode !== ENDPOINT_MODE.EXTERNAL ? '\n- Answers are grounded in uploaded documents only\n- Source citations link back to the original document filename' : ''}
`
}

export function generateLlmsTxt(config: EndpointConfig): string {
  const desc = config.description || `Knowledge base for ${config.name}.`

  return `# ${config.name}

> ${desc}

## Docs

- [SKILL.md](${config.baseUrl}/v1/e/${config.endpointId}/skill.md): How to query this knowledge base

## API

- POST ${config.baseUrl}/v1/endpoints/${config.slug}/query: Ask a question (requires API key)
`
}
