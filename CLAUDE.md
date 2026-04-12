# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AgentBase — "Chatbase for agents." Give your product a representative in the agent economy — an AI agent other agents can talk to. Companies deploy an agent endpoint that other AI agents can discover via SKILL.md, query, and transact with.

All agents run in external mode: queries are forwarded to OpenClaw-hosted agents on a VPS via webhook. The dashboard auto-provisions agents on creation. No RAG, no BYOK, no Azure Search.

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
cd apps/api && npx wrangler deploy     # CLOUDFLARE_API_TOKEN set in ~/.bashrc

# Test endpoints
curl https://agentbase.to/health
curl https://agentbase.to/a/chainletter/skill.md
```

## Architecture

**Stack:** Hono + Cloudflare Workers + D1 (SQLite) + OpenClaw (VPS agent runtime)

**Monorepo:** pnpm workspaces + Turbo. All code is in `apps/api/src/`.

### Request Flow (middleware chain)

```
Request → CORS (scoped per route group) → Logger → dbMiddleware → [authMiddleware] → [resolveEndpoint] → Route Handler
```

- `dbMiddleware` (every request): creates Drizzle instance, sets on context
- `authMiddleware` (`/v1/*` routes): validates Bearer token via `@unkey/api` `verifyKey`
- `sessionMiddleware` (`/dashboard/*` routes): validates Better Auth session cookie, sets `dashboardAuth` context
- `resolveEndpoint` (per-route, not global): loads endpoint by userId + slug
- CORS: wildcard on public routes (`/v1/*`, `/a/*`, `/query`, `/skill.md`, `/health`). No CORS on dashboard/auth routes (same-origin).

### Authentication

Two auth systems:
- **Unkey API keys** (`/v1/*` routes): programmatic access for external integrations. Key creation in `routes/accounts.ts`, verification in `middleware/auth.ts`.
- **Better Auth sessions** (`/dashboard/*` routes): OAuth login (Google, GitHub, Microsoft) with session cookies in D1. Config in `lib/auth.ts`, session middleware in `middleware/session.ts`, auth routes in `routes/auth.ts`.

### Dashboard

Server-rendered HTML from Hono routes in `routes/dashboard.ts`. Uses shared layout from `lib/html.ts` (`dashboardLayout`, `esc`, `copyBox`). Centralized CSS in `public/styles.css`.

Pages:
- `/dashboard` — agent list with plan limit check
- `/dashboard/agents/new` — name-only create form
- `POST /dashboard/api/agents` — creates endpoint + provisions OpenClaw agent via VPS API
- `/dashboard/agents/:slug` — conversation logs with confidence scoring, filtering, multi-turn grouping
- `/dashboard/agents/:slug/knowledge` — knowledge file list, view, edit, upload, delete
- `/dashboard/agents/:slug/test` — query playground (Enter to send, Shift+Enter for newline)
- `/dashboard/agents/:slug/settings` — edit name, description, status (webhook URL and system prompt hidden for hosted agents)
- `/dashboard/settings` — account info

### Query Flow

All queries go through public endpoints — no API key needed:
- `POST /a/{slug}/query` — by endpoint slug (standard path)
- `POST /query` — on custom domains

Both call `handleQuery()` in `services/query-handler.ts`:
```
POST webhook_url (OpenClaw gateway) → parse OpenAI chat completions response → extract confidence tag → log interaction
```

- Queries forwarded as OpenAI chat completions format with conversation history
- 60s webhook timeout (agents may use web search which adds latency)
- Confidence scoring: agent appends `[CONFIDENCE:confident|review|not_found|SOURCES:...]` tag, parsed by `query-handler.ts`
- Daily quota (1000/day free) tracked per-endpoint via D1 counter (atomic reset+increment)
- IP rate limiting via Cloudflare Rate Limiting Rules (edge-level)

### Agent Provisioning

When a user creates an agent in the dashboard:
1. Worker calls `POST /provision` on the VPS provisioner API (Tailscale funnel)
2. Provisioner runs `openclaw agents add`, copies auth profiles, copies SOUL.md template, sets tool permissions
3. Worker encrypts gateway token, generates SKILL.md, inserts endpoint in D1
4. Agent is live and queryable immediately

Provisioner API at `/home/brad/agent-provisioner/index.ts` (port 18790, systemd service). Also handles knowledge file CRUD (`GET/POST/DELETE /knowledge/:agentId`).

409 from provisioner (agent already exists) is treated as success — idempotent creation.

### OpenClaw Agent Workspace

Each agent has a workspace at `/home/brad/.openclaw/workspace-{slug}/`:
- `SOUL.md` — agent identity and behavior (AgentBase template in `agent-provisioner/templates/SOUL.md`)
- `IDENTITY.md`, `AGENTS.md`, `TOOLS.md` — OpenClaw standard files
- `knowledge/` — company-specific docs (.md, .txt) managed via dashboard

Tool permissions per agent: `allow: ['read', 'group:web']`, deny destructive tools (exec, write, edit, etc.). Web search via DuckDuckGo configured in `openclaw.json`.

### Custom Domains

Endpoints can have a `custom_domain` (e.g., `docs.acme.com`). Cloudflare for SaaS handles SSL provisioning. Customer adds a CNAME to `cdn.agentbase.to`. Hostname-based routing in `routes/custom-domain.ts`.

### Key Service Files

- `services/query-handler.ts` — `handleQuery()` for all query routes. External webhook call, confidence tag parsing, conversation history, interaction logging.
- `services/skill-gen.ts` — Generates per-endpoint SKILL.md + llms.txt.
- `services/custom-domains.ts` — Cloudflare for SaaS API client.

### Shared Utilities

- `utils/errors.ts` — `errorResponse()`, `serviceError()`, `ErrorCode` constants
- `utils/validate.ts` — `parseBody()` (Zod + error response), `safeJsonParse()`, `parseIntParam()`
- `utils/id.ts` — `generateId()` (UUID without hyphens)
- `utils/encrypt.ts` — AES-256-GCM encryption/decryption for webhook secrets and gateway tokens
- `utils/hmac.ts` — HMAC-SHA256 signing for external mode webhook requests
- `utils/queries.ts` — `findEndpointLite()`, `checkEndpointLimit()` shared DB query helpers
- `lib/html.ts` — `dashboardLayout()`, `authPage()`, `copyBox()`, `esc()` HTML helpers

### Static Assets & Landing Page

Static files in `apps/api/public/` served by Cloudflare Workers Static Assets.

- `index.html` — Landing page at `https://agentbase.to/`
- `styles.css` — Centralized CSS (design tokens, components, dashboard layout, log viewer, copy box)
- `auth-client.js` — Bundled Better Auth client for OAuth flows
- `skill.md`, `heartbeat.md`, `custom-domains.md`, `external-mode.md` — Platform documentation

**Design tokens:** `--bg: #09090b`, `--fg: #fafafa`, `--fg-muted: #9f9fa9`, `--green: #9ece6a`, `--border: #1e1e23`, `--surface: #060608`. Sharp corners. JetBrains Mono for headings/code, Inter for body.

### Database

D1 (SQLite via Drizzle ORM). Schema in `db/schema.ts`, migrations in `db/migrations/`.

Tables:
- `user`, `session`, `account`, `verification` — Better Auth tables for OAuth
- `endpoints` — agent endpoints (userId, slug, name, mode, webhookUrl, webhookSecret, externalModel, externalApiKey, capabilities, systemPrompt, skillMd, customDomain, queryCount, status)
- `interactions` — query logs (endpointId, query, response, latencyMs, confidence, confidenceSources, conversationId)

## Conventions

- Use `ENDPOINT_MODE`, `ENDPOINT_STATUS`, `CONFIDENCE` constants from `types.ts` — never raw strings
- Use `errorResponse()` / `serviceError()` from `utils/errors.ts` — never inline `c.json({ error: … })`
- Use `parseBody(c, schema)` from `utils/validate.ts` — never inline Zod safeParse
- Use `generateId()` from `utils/id.ts`
- Use `findEndpointLite()` from `utils/queries.ts` for dashboard endpoint lookups
- Use `copyBox()` from `lib/html.ts` for URL copy widgets
- Interactions logged via `c.executionCtx.waitUntil()` — fire and forget
- SKILL.md auto-generated on endpoint creation and auto-regenerated on PATCH when name, description, capabilities, or custom_domain change
- Webhook secrets and gateway tokens encrypted at rest via AES-256-GCM
- Dashboard forms use Better Auth session cookies (SameSite: Lax — CSRF safe)
- Knowledge file uploads validated with `KNOWLEDGE_FILENAME_RE` and `MAX_KNOWLEDGE_SIZE` on both dashboard and provisioner

## Environment

Secrets via `wrangler secret put` (production):
```
ENCRYPTION_SECRET              — AES-256-GCM key for encrypting secrets at rest
UNKEY_ROOT_KEY, UNKEY_API_ID   — Unkey API key management
CF_ZONE_ID, CF_API_TOKEN       — Cloudflare zone management + custom domains
BETTER_AUTH_SECRET, BETTER_AUTH_URL — Better Auth config
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — Google OAuth
GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET — GitHub OAuth
MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET — Microsoft OAuth
OPENCLAW_PROVISION_URL, OPENCLAW_PROVISION_SECRET — VPS agent provisioner
OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN — OpenClaw gateway for query forwarding
```

Production URL: `https://agentbase.to`
D1 database ID: `7e9dea6e-9a9f-4667-bb64-ab3ee46ef7f7`
`CLOUDFLARE_API_TOKEN` set in `~/.bashrc` for deploys.
