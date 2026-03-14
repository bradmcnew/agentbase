import { Hono } from 'hono'
import type { Env } from '../types'

const SKILL_MD = `---
name: agentport
version: 1.0.0
description: Create agent-facing knowledge endpoints. Upload docs, get a hosted API that AI agents can query.
base_url: https://api.agentport.dev
auth: api_key
auth_header: Authorization
auth_format: "Bearer {api_key}"
tags:
  - agent-infrastructure
  - rag
  - knowledge-base
---

# Skill: AgentPort

## Purpose

Create and manage agent-facing knowledge endpoints. Upload your documentation, define what your endpoint can do, and get a hosted API that other AI agents can query to get answers grounded in your docs.

AgentPort is itself agent-accessible. You can create an account, upload documents, and deploy an endpoint entirely through this API with no human involvement.

## Quick Start

1. Create an account: POST /v1/accounts with {"name": "your-company"}
2. You'll receive an API key. Use it for all subsequent requests.
3. Create an endpoint: POST /v1/endpoints with name, description, and capabilities.
4. Upload documents: POST /v1/endpoints/{slug}/docs with your docs.
5. Query: POST /v1/endpoints/{slug}/query with your question.

## Capabilities

### create_account
Create a new AgentPort account. No authentication required.
- Method: POST
- Path: /v1/accounts
- Body: {"name": "string"}
- Returns: account object + API key (save this — shown only once)

### create_endpoint
Create a new knowledge endpoint.
- Method: POST
- Path: /v1/endpoints
- Auth: Bearer API key
- Body: {"slug": "string", "name": "string", "description"?: "string", "capabilities"?: ["string"]}

### upload_document
Add a document to an endpoint's knowledge base.
- Method: POST
- Path: /v1/endpoints/{slug}/docs
- Auth: Bearer API key
- Body: {"content": "string", "filename": "string"}
- Documents are automatically chunked and indexed for search.

### query_endpoint
Ask a question against an endpoint's knowledge base.
- Method: POST
- Path: /v1/endpoints/{slug}/query
- Auth: Bearer API key
- Body: {"query": "string", "context"?: "string"}
- Returns: answer, source documents, usage stats

### list_endpoints
List all endpoints for your account.
- Method: GET
- Path: /v1/endpoints
- Auth: Bearer API key

### list_documents
List all documents for an endpoint.
- Method: GET
- Path: /v1/endpoints/{slug}/docs
- Auth: Bearer API key

### get_public_skill
Fetch an endpoint's SKILL.md (public, no auth required). The URL is returned in the endpoint creation response as skill_md_url.
- Method: GET
- Path: /v1/e/{endpoint_id}/skill.md
- Auth: None (public)

## Constraints

- Free accounts: 3 endpoints, 50 queries/day
- Rate limit: 60 requests/minute per API key
- Account creation rate limit: 5 per hour per IP
- Max document size: 10MB
- Supported formats: Markdown (.md), Plain text (.txt)
- API key is shown only once at account creation. Store it securely.

## Error Format

All errors return: {"error": {"code": "ERROR_CODE", "message": "Human-readable message"}}
Common codes: UNAUTHORIZED, NOT_FOUND, RATE_LIMITED, VALIDATION_ERROR

## Examples

### Agent self-onboarding (zero human involvement)

Step 1 — Create account:
POST /v1/accounts
Content-Type: application/json
{"name": "Acme Corp"}

Response:
{"account": {"id": "abc123", "name": "Acme Corp"}, "api_key": "ap_sk_a1b2c3d4..."}

Step 2 — Create endpoint:
POST /v1/endpoints
Authorization: Bearer ap_sk_a1b2c3d4...
Content-Type: application/json
{"slug": "api-help", "name": "API Help", "description": "Answers questions about the Acme API"}

Response includes skill_md_url — the public URL where other agents can read this endpoint's SKILL.md:
{"endpoint": {"id": "def456", "slug": "api-help", "skill_md_url": "https://api.agentport.dev/v1/e/def456/skill.md", ...}}

Step 3 — Upload docs:
POST /v1/endpoints/api-help/docs
Authorization: Bearer ap_sk_a1b2c3d4...
Content-Type: application/json
{"content": "# Authentication\\nUse Bearer tokens in the Authorization header.", "filename": "auth.md"}

Step 4 — Query:
POST /v1/endpoints/api-help/query
Authorization: Bearer ap_sk_a1b2c3d4...
Content-Type: application/json
{"query": "How do I authenticate?"}

Response:
{"answer": "Use Bearer tokens in the Authorization header.", "sources": [...]}
`

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => {
  return c.json({ status: 'ok', version: '0.1.0' })
})

app.get('/.well-known/skill.md', (c) => {
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.text(SKILL_MD)
})

export default app
