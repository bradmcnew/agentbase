/**
 * Cloudflare for SaaS custom hostname management.
 * Creates/deletes custom hostnames so customers can use their own domains.
 * Cloudflare handles SSL provisioning automatically.
 */

const CF_API = 'https://api.cloudflare.com/client/v4'
const CNAME_TARGET = 'cdn.agentbase.to'

interface CustomHostnameResult {
  id: string
  hostname: string
  status: string
}

export async function createCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string
): Promise<CustomHostnameResult> {
  const res = await fetch(`${CF_API}/zones/${zoneId}/custom_hostnames`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      hostname,
      ssl: {
        method: 'http',
        type: 'dv',
        settings: { min_tls_version: '1.2' },
      },
    }),
  })

  const data = await res.json() as { success: boolean; result?: CustomHostnameResult; errors?: Array<{ message: string }> }
  if (!data.success) {
    const msg = data.errors?.[0]?.message || 'Unknown Cloudflare error'
    throw new Error(`Failed to create custom hostname: ${msg}`)
  }

  return data.result!
}

export async function deleteCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string
): Promise<void> {
  // First, find the custom hostname ID by listing and filtering
  const listRes = await fetch(
    `${CF_API}/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    { headers: { 'Authorization': `Bearer ${apiToken}` } }
  )

  const listData = await listRes.json() as { success: boolean; result?: Array<{ id: string }> }
  if (!listData.success || !listData.result?.length) return

  const hostnameId = listData.result[0].id

  await fetch(`${CF_API}/zones/${zoneId}/custom_hostnames/${hostnameId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${apiToken}` },
  })
}

export { CNAME_TARGET }
