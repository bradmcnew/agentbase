# AgentBase

**Chatbase for agents** — make your SaaS agent-accessible in minutes.

AgentBase (AgentPort) gives your product a machine-readable front door: publish an
`llms.txt` / skill description of what your SaaS does, and AI agents (ChatGPT, Claude,
and other MCP/Apps-SDK clients) can discover and use it without a custom integration.

## What it does

- **Agent discovery** — serves `/.well-known/llms.txt` and `skill.md` so agents can find
  and understand your product automatically.
- **Audits** — public audit pages showing how well-known SaaS products (Clerk, Neon,
  Resend, Supabase, and more) present themselves to agents: see `apps/api/public/audit/`.
- **Auth & multi-tenancy** — better-auth accounts, Unkey API keys, custom domains.

## Stack

| Layer | Tech |
|---|---|
| API | Hono on Cloudflare Workers (Wrangler) |
| DB | Cloudflare D1 + Drizzle ORM |
| Auth | better-auth, Unkey |
| Monorepo | Turborepo + pnpm |

## Quick start

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill in your secrets
pnpm dev
```

Database (local D1):

```bash
pnpm --filter @agentport/api db:migrate:local
```

## Layout

- `apps/api/` — Cloudflare Worker: API, `/.well-known/` discovery files, audit pages
- `references/` — reference material for the discovery/audit formats

## License

[MIT](LICENSE) © Brad McNew
