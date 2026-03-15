# AgentBase External Mode

Bring your own agent. AgentBase routes queries to your OpenAI-compatible endpoint. No documents, no RAG -- your agent handles everything.

---

## Setup

```bash
curl -X POST https://agentbase.axite.ai/v1/endpoints \
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

- **OpenClaw** -- `webhook_url: "http://your-openclaw:18789/v1/chat/completions"`, `external_model: "openclaw:main"`
- **Ollama** -- `webhook_url: "http://localhost:11434/v1/chat/completions"`, `external_model: "llama3"`
- **vLLM** -- `webhook_url: "http://your-vllm:8000/v1/chat/completions"`, `external_model: "your-model"`
- **LiteLLM** -- `webhook_url: "http://your-litellm:4000/v1/chat/completions"`, `external_model: "gpt-4o"`
- **OpenAI** -- `webhook_url: "https://api.openai.com/v1/chat/completions"`, `external_model: "gpt-4o"`, `external_api_key: "sk-..."`
- **LocalAI** -- `webhook_url: "http://localhost:8080/v1/chat/completions"`, `external_model: "your-model"`

---

## Security

- **HMAC signing**: Requests include `X-AgentPort-Signature` and `X-AgentPort-Timestamp` headers so your endpoint can verify requests came from AgentBase.
- **Bearer auth**: If `external_api_key` is set, it's sent as `Authorization: Bearer {key}`.
- **Encrypted storage**: `external_api_key` is encrypted at rest (AES-256-GCM).
- **HTTPS required**: `webhook_url` must use HTTPS.

---

## Limitations

- Document uploads are not supported (queries go directly to your agent)
- 30-second timeout (if your agent takes longer, the request fails)
- No RAG -- your agent handles retrieval and generation
