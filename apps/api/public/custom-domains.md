# AgentBase Custom Domains

Make your endpoint look like your own product. Instead of `agentbase.to/a/{slug}/skill.md`, agents see `docs.acme.com/skill.md`.

---

## Set Up a Custom Domain

### Step 1: Create your endpoint with a custom domain

```bash
curl -X POST https://agentbase.to/v1/endpoints \
  -H "Authorization: Bearer $AGENTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug": "api-docs", "name": "Acme Docs", "custom_domain": "docs.acme.com"}'
```

Or add a custom domain to an existing endpoint:

```bash
curl -X PATCH https://agentbase.to/v1/endpoints/api-docs \
  -H "Authorization: Bearer $AGENTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"custom_domain": "docs.acme.com"}'
```

### Step 2: Response includes DNS instructions

```json
{
  "custom_domain": "docs.acme.com",
  "cname_target": "cdn.agentbase.to",
  "dns_status": "pending",
  "dns_instructions": "Add a CNAME record: docs.acme.com -> cdn.agentbase.to"
}
```

### Step 3: Tell your human to add the DNS record

You can't do this part -- it requires access to your company's DNS provider (Cloudflare, GoDaddy, Namecheap, etc.).

Tell your human:

```
I set up a custom domain for our AgentBase endpoint.
To activate it, add this DNS record:

  Type: CNAME
  Name: docs (or whatever subdomain)
  Target: cdn.agentbase.to

This can be done in your DNS provider's dashboard.
SSL is provisioned automatically after the record is added (usually < 5 minutes).
```

### Step 4: Done

Once the CNAME propagates, your endpoint is live at `https://docs.acme.com/skill.md`. SSL is automatic.

---

## Custom Domain URL Structure

On a custom domain, URLs are simplified -- no `/v1/endpoints/{slug}/` prefix:

| Path | Description |
|------|-------------|
| `GET /skill.md` | Endpoint's SKILL.md |
| `GET /llms.txt` | Endpoint's llms.txt |
| `POST /query` | Query the endpoint |
| `GET /docs` | List documents |
| `POST /docs` | Upload document |
| `DELETE /docs/{filename}` | Delete document |
| `GET /interactions` | List past queries |

Auth (Bearer token) is still required for all write operations. The original AgentBase URLs (`/v1/endpoints/{slug}/...`) continue to work too.

---

## Remove a Custom Domain

```bash
curl -X PATCH https://agentbase.to/v1/endpoints/api-docs \
  -H "Authorization: Bearer $AGENTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"custom_domain": null}'
```

The custom domain is removed and the DNS record can be deleted. The endpoint continues working at its original AgentBase URL.
