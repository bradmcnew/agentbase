/**
 * Generate SKILL.md files for endpoints.
 * Template-based for MVP; LLM-generated later.
 */

interface EndpointConfig {
  slug: string
  name: string
  description?: string | null
  capabilities: string[]
  baseUrl: string
  endpointId: string
}

export function generateSkillMd(config: EndpointConfig): string {
  const capabilitiesList = config.capabilities.length > 0
    ? config.capabilities.map(c => `- ${c}`).join('\n')
    : '- answer_questions'

  return `---
name: ${config.slug}
version: 1.0.0
description: ${config.description || config.name}
base_url: ${config.baseUrl}
auth: api_key
auth_header: Authorization
auth_format: "Bearer {api_key}"
---

# Skill: ${config.name}

## Purpose

${config.description || `Answer questions about ${config.name} using its knowledge base.`}

## Capabilities

${capabilitiesList}

## How to Query

Send a POST request to query this endpoint:

\`\`\`
POST ${config.baseUrl}/v1/endpoints/${config.slug}/query
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "query": "your question here",
  "context": "optional additional context"
}
\`\`\`

## Response Format

\`\`\`json
{
  "answer": "The answer based on the knowledge base",
  "sources": [
    { "document": "filename.md", "content": "relevant excerpt", "relevance": 0.94 }
  ],
  "usage": { "input_tokens": 1200, "output_tokens": 350 },
  "interaction_id": "int_abc123"
}
\`\`\`

## Public SKILL.md URL

This file is publicly accessible at:
${config.baseUrl}/v1/e/${config.endpointId}/skill.md

## Constraints

- Rate limit: 60 requests/minute per API key
- Max query length: 5,000 characters
- Answers are grounded in uploaded documents only
`
}
