# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AgentBase — "Chatbase for agents." Give your product a representative in the agent economy -- an AI agent other agents can talk to. The platform itself is agent-accessible via SKILL.md. Three endpoint modes: platform (hosted agent powered by our RAG + LLM), BYOK (customer's LLM key, our RAG), external (customer's own agent, our discovery layer).

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
curl https://agentbase.to/health
curl https://agentbase.to/skill.md
```

## Architecture

**Stack:** Hono + Cloudflare Workers + D1 (SQLite) + Azure AI Search + Azure OpenAI

**Monorepo:** pnpm workspaces + Turbo. All code is in `apps/api/src/`.

### Request Flow (middleware chain)

```
Request → CORS → Logger → dbMiddleware → [authMiddleware] → [resolveEndpoint] → Route Handler
```

- `dbMiddleware` (every request): creates Drizzle instance, sets on context
- `authMiddleware` (protected routes): validates Bearer token via `@unkey/api` `verifyKey`. Allows `USAGE_EXCEEDED` through (non-query routes still work when credits exhausted).
- `resolveEndpoint` (per-route, not global): loads endpoint by accountId + slug, applied as `resolveEndpoint as any` on individual route handlers

### Query Routes (Public)

All queries go through public endpoints — no API key needed:
- `POST /a/{slug}/query` — by endpoint slug (standard path)
- `POST /query` — on custom domains

Both call `handleQuery()` in `services/query-handler.ts`. Daily quota (50/day free) tracked via D1 counter on `endpoints` table (atomic reset+increment). IP rate limiting via Cloudflare Rate Limiting Rules (edge-level, not in-memory).

### Core Query Flow (`services/query-handler.ts`)

```
External mode:  POST {webhook_url} → parse response → log interaction
Platform/BYOK:  embed(query) → search(index, query, vector) → chatWithProvider(…) → log interaction
```

- Embedding always uses our Azure OpenAI (even BYOK)
- Chat routes through `services/llm-chat.ts` → `chatWithProvider()` which switches on `endpoint.mode`
- Azure Search does hybrid search: BM25 + HNSW vector + semantic reranking (Standard tier)
- Default system prompt is optimized for agent-to-agent responses (no markdown, no filler, structured output)
- Endpoints can override with custom `system_prompt` via PATCH

### Three Endpoint Modes

- **platform**: Our Azure handles everything. Customer picks model (`gpt-5-mini` default, `gpt-5-nano` lightweight). Model validated against `PLATFORM_MODELS` constant at runtime — invalid models silently fall back to default. Creates Azure Search index on endpoint creation.
- **byok**: Customer provides OpenAI/Anthropic/Gemini key for LLM chat. We still handle embedding + search. Creates Azure Search index. Customer keys encrypted at rest via AES-256-GCM.
- **external**: Customer provides webhook URL. No Azure Search index. No doc uploads. We forward query as OpenAI chat completions format (30s timeout). Webhook requests signed with HMAC-SHA256 (`whsec_` prefixed secret, encrypted at rest). Customer verifies via `X-AgentPort-Signature` + `X-AgentPort-Timestamp` headers.

### Custom Domains

Endpoints can have a `custom_domain` (e.g., `docs.acme.com`). Cloudflare for SaaS handles SSL provisioning. Customer adds a CNAME to `cdn.agentbase.to`. Hostname-based routing in `routes/custom-domain.ts` resolves endpoint by `custom_domain` column. Simplified URL structure on custom domains (`/skill.md`, `/query`, `/docs` instead of `/v1/endpoints/{slug}/...`).

### Key Service Files

- `services/query-handler.ts` — Shared `handleQuery()` used by public query route, authenticated query route, and custom domain query route. Contains all query logic (external webhook, RAG pipeline, interaction logging).
- `services/azure-search.ts` — Azure AI Search client. `AzureSearchClient.indexName(accountId, slug)` generates index names. Supports `listDocuments(indexName, filename?)` with OData server-side filtering, `deleteDocuments(indexName, docIds)` for batch delete.
- `services/azure-openai.ts` — Azure OpenAI client. `embedBatch()` for chunked docs (16 per batch). `chat()` accepts optional `modelOverride`.
- `services/llm-chat.ts` — Routes `chatWithProvider()` to Azure (platform), OpenAI API (byok/openai), or Anthropic API (byok/anthropic). Decrypts BYOK keys at runtime.
- `services/skill-gen.ts` — Generates per-endpoint SKILL.md + llms.txt. Uses `ENDPOINT_MODE` constants. Pass `mode` and `customDomain` when calling. Generated SKILL.md points to public query URL (no auth required).
- `services/custom-domains.ts` — Cloudflare for SaaS API client. Creates/deletes custom hostnames.

### Shared Utilities

- `utils/errors.ts` — `errorResponse()`, `serviceError()` (logs real error, returns sanitized message), `ErrorCode` constants
- `utils/validate.ts` — `parseBody()` (Zod + error response), `safeJsonParse()`, `parseIntParam()`
- `utils/id.ts` — `generateId()` (UUID without hyphens)
- `utils/chunker.ts` — `chunkText()` (~2000 chars/chunk, 200 char overlap, breaks at paragraph/sentence boundaries)
- `utils/encrypt.ts` — AES-256-GCM encryption/decryption for BYOK API keys at rest
- `utils/hmac.ts` — HMAC-SHA256 signing for external mode webhook requests

### Static Assets & Landing Page

Static files in `apps/api/public/` served by Cloudflare Workers Static Assets (configured in wrangler.toml `[assets]`). No route handler needed — Cloudflare serves them at the edge.

- `index.html` — Landing page at `https://agentbase.to/`. Single-file static HTML with inline CSS (Tailwind-free). Uses JetBrains Mono + Inter from Google Fonts. Dark terminal aesthetic inspired by AgentMail. Design tokens in CSS `:root` variables. No build step — edit and deploy.
- `skill.md`, `heartbeat.md`, `custom-domains.md`, `external-mode.md` — Platform documentation (agent-readable)
- `.well-known/llms.txt`, `.well-known/skill.md` — Standard discovery files

**Landing page conventions:**
- Colors: `--bg: #09090b`, `--fg: #fafafa`, `--fg-muted: #9f9fa9`, `--green: #9ece6a`, `--border: #1e1e23`, `--surface: #060608` (darker than bg)
- Sharp corners on all containers (no border-radius) — matches AgentMail's style
- Copy box uses card pattern: header with label, body with URL + copy icon
- Fonts: JetBrains Mono for headings/code/UI, Inter for body text

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
- Per-key rate limiting is handled by Unkey (set on key creation: 60 req/min). Only `POST /v1/accounts` uses in-memory IP rate limiting. Public query routes use Cloudflare Rate Limiting Rules (edge-level).
- Daily query quota (50/day free tier) tracked per-endpoint via D1 counter (`query_count` + `query_count_reset_at` columns). Atomic reset+increment in `services/query-handler.ts` using raw SQL with RETURNING clause. Resets 24h after first query in window.
- Endpoint limit (3 active per free account) enforced via D1 COUNT in `routes/endpoints.ts`.
- Plan limits defined in `PLAN_LIMITS` constant in `types.ts`. Platform models defined in `PLATFORM_MODELS` constant — enforced at runtime in `llm-chat.ts`.
- SKILL.md is auto-generated on endpoint creation and auto-regenerated on PATCH when `name`, `description`, `capabilities`, or `custom_domain` change. Manual regeneration via `POST /v1/endpoints/{slug}/skill`.
- PDF uploads accepted via `pdf` field (base64-encoded), extracted in-worker using `unpdf`. Max 10MB base64.
- Document deletion by filename via `DELETE /v1/endpoints/{slug}/docs/{filename}` — uses Azure Search OData `$filter` for server-side filtering.
- Azure error messages are never exposed to users — use `serviceError()` which logs internally and returns generic message
- **Always update skill files** when changing API behavior, adding fields, or modifying endpoints. Keep `public/skill.md` and `public/.well-known/skill.md` in sync (identical content). Check all references — Quick Start examples, field descriptions, API tables, Endpoint Modes section. Move detailed setup guides to separate files (e.g., `external-mode.md`, `custom-domains.md`) to keep the main SKILL.md scannable.

## Environment

Secrets in `.dev.vars` (local) or `wrangler secret put` (production):
```
AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_API_KEY
AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY
AZURE_OPENAI_EMBEDDING_DEPLOYMENT (text-embedding)
AZURE_OPENAI_CHAT_DEPLOYMENT (gpt-5-mini)
ENCRYPTION_SECRET (AES-256-GCM key for BYOK API key encryption)
UNKEY_ROOT_KEY (Unkey root key for API key management)
UNKEY_API_ID (Unkey API ID)
CF_ZONE_ID (Cloudflare zone ID for axite.ai)
CF_API_TOKEN (Cloudflare API token with DNS + Custom Hostname permissions)
```

Production URL: `https://agentbase.to`
Custom domains: customers can set `custom_domain` on endpoints (CF for SaaS auto-provisions SSL). Default URL is path-based: `/a/{slug}/skill.md`.
D1 database ID: `7e9dea6e-9a9f-4667-bb64-ab3ee46ef7f7`
Cloudflare API token needed for deploys (set as `CLOUDFLARE_API_TOKEN` env var).
