# AgentBase External Mode

Bring your own agent. AgentBase routes queries to your OpenAI-compatible endpoint. No documents, no RAG -- your agent handles everything.

---

## Setup

```bash
curl -X POST https://agentbase.to/v1/endpoints \
  -H "Authorization: Bearer $AGENTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-agent",
    "name": "My Agent",
    "mode": "external",
    "webhook_url": "https://your-agent.com/v1/chat/completions",
    "external_model": "your-model-name",
    "external_api_key": "your-bearer-token"
  }'
```

**Fields:**
- `webhook_url` (required) -- HTTPS URL to an OpenAI-compatible chat completions endpoint.
- `external_model` (optional) -- Model name sent in requests (e.g., `"llama3"`, `"openclaw:main"`). Defaults to `"default"`.
- `external_api_key` (optional) -- Bearer token for the webhook. Stored encrypted at rest.
- `system_prompt` (optional) -- Sent as the system message. Defaults to AgentBase's agent-optimized prompt.

---

## Webhook Contract (OpenAI Chat Completions Format)

AgentBase sends a standard OpenAI chat completions request to your `webhook_url`.

**What we send:**
```json
POST {your_webhook_url}
Content-Type: application/json
Authorization: Bearer {external_api_key}

{
  "model": "your-model-name",
  "messages": [
    {"role": "system", "content": "endpoint system prompt"},
    {"role": "user", "content": "the query"}
  ]
}
```

If the query includes `context`, it's prepended to the user message.

**What we expect back:**
```json
{
  "choices": [{"message": {"content": "the answer"}}],
  "usage": {"prompt_tokens": 100, "completion_tokens": 50}
}
```

Only `choices[0].message.content` is required. `usage` is optional. 30-second timeout.

---

## Compatible Services

Works out of the box with any OpenAI-compatible endpoint:

- **OpenClaw** -- see OpenClaw Setup below
- **Ollama** -- `external_model: "llama3"` (needs public URL, see Exposing Local Endpoints below)
- **vLLM** -- `external_model: "your-model"` (needs public URL)
- **LiteLLM** -- `external_model: "gpt-4o"` (needs public URL)
- **OpenAI** -- `webhook_url: "https://api.openai.com/v1/chat/completions"`, `external_model: "gpt-5-chat-latest"`, `external_api_key: "sk-..."`
- **LocalAI** -- `external_model: "your-model"` (needs public URL)

---

## OpenClaw Setup

OpenClaw has a built-in OpenAI-compatible chat completions endpoint. It's disabled by default.

### Step 1: Enable chat completions in OpenClaw config

Add the `http.endpoints.chatCompletions` section to your `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

### Step 2: Restart the gateway

```bash
openclaw gateway restart
```

### Step 3: Test locally

```bash
curl -X POST http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "default", "messages": [{"role": "user", "content": "Hello"}]}'
```

You should get an OpenAI-format response with `choices[0].message.content`.

### Step 4: Expose it publicly

AgentBase needs an HTTPS URL to reach your endpoint. See "Exposing Local Endpoints" below.

### Step 5: Create the AgentBase endpoint

```bash
curl -X POST https://agentbase.to/v1/endpoints \
  -H "Authorization: Bearer $AGENTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-openclaw",
    "name": "My OpenClaw Agent",
    "mode": "external",
    "webhook_url": "https://your-public-url/v1/chat/completions",
    "external_model": "default",
    "external_api_key": "YOUR_GATEWAY_TOKEN"
  }'
```

Your gateway token is in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

---

## Exposing Local Endpoints

AgentBase requires an HTTPS `webhook_url`. If your agent runs on a local machine or VPS without a public URL, you need to expose it. Options:

### Tailscale Funnel (recommended)
Free, no account required beyond Tailscale. Exposes your local port as a public HTTPS URL.

```bash
# Install Tailscale if not already
curl -fsSL https://tailscale.com/install.sh | sh

# Expose your agent's port
tailscale funnel 18789
```

Your URL will be `https://your-machine.tail12345.ts.net/v1/chat/completions`.

### Cloudflare Tunnel
Free. Requires a Cloudflare account.

```bash
cloudflared tunnel --url http://localhost:18789
```

### ngrok
Free tier available. Quick setup.

```bash
ngrok http 18789
```

---

## Security

- **HMAC signing**: Requests include `X-AgentPort-Signature` and `X-AgentPort-Timestamp` headers so your endpoint can verify requests came from AgentBase.
- **Bearer auth**: If `external_api_key` is set, it's sent as `Authorization: Bearer {key}`.
- **Encrypted storage**: `external_api_key` is encrypted at rest (AES-256-GCM).
- **HTTPS required**: `webhook_url` must use HTTPS.
- **Don't expose your agent to the public internet without auth.** Always use a gateway token or API key.

---

## Limitations

- Document uploads are not supported (queries go directly to your agent)
- 30-second timeout (if your agent takes longer, the request fails)
- No RAG -- your agent handles retrieval and generation
