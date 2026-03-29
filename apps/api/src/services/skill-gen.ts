/**
 * Generate per-endpoint SKILL.md and llms.txt files.
 * These are what CONSUMER agents read to learn how to query an endpoint.
 */

interface EndpointConfig {
  slug: string
  name: string
  description?: string | null
  capabilities: string[]
  baseUrl: string
  endpointId: string
  customDomain?: string | null
}

export function generateSkillMd(config: EndpointConfig): string {
  const caps = config.capabilities.length > 0
    ? config.capabilities.map(c => `- ${c}`).join('\n')
    : '- answer_questions'

  const desc = config.description || `Agent endpoint for ${config.name}. Query via REST API.`

  const hasCustomDomain = !!config.customDomain
  const skillBaseUrl = hasCustomDomain ? `https://${config.customDomain}` : config.baseUrl
  const queryPath = hasCustomDomain ? `${skillBaseUrl}/query` : `${config.baseUrl}/a/${config.slug}/query`
  const skillMdUrl = hasCustomDomain ? `${skillBaseUrl}/skill.md` : `${config.baseUrl}/a/${config.slug}/skill.md`
  const llmsTxtUrl = hasCustomDomain ? `${skillBaseUrl}/llms.txt` : `${config.baseUrl}/a/${config.slug}/llms.txt`

  return `---
name: ${config.slug}
description: ${desc}
metadata:
  version: "1.0.0"
  base_url: ${skillBaseUrl}
  endpoint_id: ${config.endpointId}
---

# ${config.name}

${desc}

## Skill Files

| File | URL |
|------|-----|
| **SKILL.md** (this file) | \`${skillMdUrl}\` |
| **llms.txt** | \`${llmsTxtUrl}\` |

---

## How to Query

\`\`\`bash
curl -X POST ${queryPath} \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your question here"}'
\`\`\`

No API key required. Just send your query.

**Fields:**
- \`query\` (required) — Your question. Max 5,000 characters.
- \`context\` (optional) — Additional context to improve the answer.
- \`conversation_id\` (optional) — Continue a previous conversation.

**Response:**
\`\`\`json
{
  "answer": "The answer to your question.",
  "conversation_id": "conv_xyz",
  "confidence": "confident"
}
\`\`\`

- \`confidence\` — how much to trust the response: \`confident\`, \`review\`, or \`not_found\`
- \`conversation_id\` — pass this back in your next query to continue the conversation

## Capabilities

${caps}

## Constraints

- Rate limit: 2 requests per 10 seconds per IP
- Max query length: 5,000 characters
`
}

export function generateLlmsTxt(config: EndpointConfig): string {
  const desc = config.description || `Agent endpoint for ${config.name}.`
  const hasCustomDomain = !!config.customDomain
  const skillMdUrl = hasCustomDomain ? `https://${config.customDomain}/skill.md` : `${config.baseUrl}/a/${config.slug}/skill.md`
  const queryUrl = hasCustomDomain ? `https://${config.customDomain}/query` : `${config.baseUrl}/a/${config.slug}/query`

  return `# ${config.name}

> ${desc}

## Docs

- [SKILL.md](${skillMdUrl}): How to query this agent endpoint

## API

- POST ${queryUrl}: Ask a question (no auth required)
`
}
