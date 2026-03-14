# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AgentPort — "Chatbase for agents." A platform where companies upload docs and get hosted knowledge endpoints that AI agents can query. The platform itself is agent-accessible via SKILL.md. Three endpoint modes: platform (we handle RAG + LLM), BYOK (customer's LLM key, our RAG), external (customer's webhook agent).

## Commands

```bash
# Development
cd apps/api && pnpm dev              # Local dev server at http://localhost:8787

# Type checking
cd apps/api && npx tsc --noEmit

# Database migrations
cd apps/api && pnpm db:migrate:local   # Apply to local D1
cd apps/api && pnpm db:migrate:remote  # Apply to production D1

# Deploy
cd apps/api && CLOUDFLARE_API_TOKEN=... npx wrangler deploy

# Test endpoints
curl https://agentbase.axite.ai/health
curl https://agentbase.axite.ai/.well-known/skill.md
```

## Architecture

**Stack:** Hono + Cloudflare Workers + D1 (SQLite) + Azure AI Search + Azure OpenAI

**Monorepo:** pnpm workspaces + Turbo. All code is in `apps/api/src/`.

### Request Flow (middleware chain)

```
Request → CORS → Logger → dbMiddleware → [authMiddleware] → [resolveEndpoint] → Route Handler
```

- `dbMiddleware` (every request): creates Drizzle instance, sets on context
- `authMiddleware` (protected routes): validates Bearer token via Unkey API (handles key validation, expiration, per-key rate limiting)
- `resolveEndpoint` (per-route, not global): loads endpoint by accountId + slug, applied as `resolveEndpoint as any` on individual route handlers

### Core Query Flow (`routes/query.ts`)

```
External mode:  POST {webhook_url} → parse response → log interaction
Platform/BYOK:  embed(query) → search(index, query, vector) → chatWithProvider(…) → log interaction
```

- Embedding always uses our Azure OpenAI (even BYOK)
- Chat routes through `services/llm-chat.ts` → `chatWithProvider()` which switches on `endpoint.mode`
- Azure Search does hybrid search: BM25 + HNSW vector + semantic reranking (Standard tier)

### Three Endpoint Modes

- **platform**: Our Azure handles everything. Customer picks model (`gpt-5-mini` default, `gpt-5-nano` lightweight). Creates Azure Search index on endpoint creation.
- **byok**: Customer provides OpenAI/Anthropic key for LLM chat. We still handle embedding + search. Creates Azure Search index.
- **external**: Customer provides webhook URL. No Azure Search index. No doc uploads. We forward `{query, context}`, expect `{answer}` back (30s timeout).

### Key Service Files

- `services/azure-search.ts` — Azure AI Search client. `AzureSearchClient.indexName(accountId, slug)` generates index names.
- `services/azure-openai.ts` — Azure OpenAI client. `embedBatch()` for chunked docs (16 per batch). `chat()` accepts optional `modelOverride`.
- `services/llm-chat.ts` — Routes `chatWithProvider()` to Azure (platform), OpenAI API (byok/openai), or Anthropic API (byok/anthropic).
- `services/skill-gen.ts` — Generates per-endpoint SKILL.md + llms.txt. Uses `ENDPOINT_MODE` constants. Pass `mode` when calling.

### Shared Utilities

- `utils/errors.ts` — `errorResponse()`, `serviceError()` (logs real error, returns sanitized message), `ErrorCode` constants
- `utils/validate.ts` — `parseBody()` (Zod + error response), `safeJsonParse()`, `parseIntParam()`
- `utils/id.ts` — `generateId()` (UUID without hyphens)
- `utils/chunker.ts` — `chunkText()` (~2000 chars/chunk, 200 char overlap, breaks at paragraph/sentence boundaries)

### Static Assets

Platform SKILL.md and llms.txt are static files in `apps/api/public/.well-known/`. Served by Cloudflare Workers Static Assets (configured in wrangler.toml `[assets]`). No route handler needed — Cloudflare serves them at the edge.

### Database

D1 (SQLite via Drizzle ORM). Three tables: `accounts`, `endpoints`, `interactions`. Schema in `db/schema.ts`, migrations in `db/migrations/`. API keys are managed by Unkey (not stored in D1). The `endpoints` table has nullable `azure_index_name` (empty string for external mode due to NOT NULL in original migration).

## Conventions

- Use `ENDPOINT_MODE` and `ENDPOINT_STATUS` constants from `types.ts` — never raw strings for mode/status comparisons
- Use `errorResponse()` / `serviceError()` from `utils/errors.ts` — never inline `c.json({ error: … })`
- Use `parseBody(c, schema)` from `utils/validate.ts` — never inline Zod safeParse + error formatting
- Use `generateId()` from `utils/id.ts`
- Apply `resolveEndpoint as any` per-route (not `app.use('*')`) — global apply breaks routes without `:slug` param
- Interactions are logged via `c.executionCtx.waitUntil()` — fire and forget, don't block response
- API keys are managed by Unkey — key creation in `routes/accounts.ts` via `@unkey/api`, verification in `middleware/auth.ts`
- Per-key rate limiting is handled by Unkey (set on key creation: 60 req/min). Only `POST /v1/accounts` uses in-memory IP rate limiting.
- Daily query quota (50/day free tier) uses Unkey credits with daily auto-refill. Query route uses `authWithCredits` middleware (direct @unkey/api with credit deduction), other routes use `authMiddleware` (@unkey/hono, no credit deduction).
- Endpoint limit (3 active per free account) enforced via D1 COUNT in `routes/endpoints.ts`.
- Plan limits defined in `PLAN_LIMITS` constant in `types.ts`.
- Azure error messages are never exposed to users — use `serviceError()` which logs internally and returns generic message

## Environment

Secrets in `.dev.vars` (local) or `wrangler secret put` (production):
```
AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_API_KEY
AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY
AZURE_OPENAI_EMBEDDING_DEPLOYMENT (text-embedding)
AZURE_OPENAI_CHAT_DEPLOYMENT (gpt-5-mini)
UNKEY_ROOT_KEY (Unkey root key for API key management)
UNKEY_API_ID (Unkey API ID)
```

Production URL: `https://agentbase.axite.ai`
D1 database ID: `7e9dea6e-9a9f-4667-bb64-ab3ee46ef7f7`
Cloudflare API token needed for deploys (set as `CLOUDFLARE_API_TOKEN` env var).
