/**
 * API key generation and validation.
 * Keys are prefixed with "ap_sk_" for easy identification.
 * Only the SHA-256 hash is stored; the raw key is returned once at creation.
 */

export async function generateApiKey(): Promise<{ raw: string; hash: string; prefix: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const raw = `ap_sk_${hex}`
  const prefix = raw.slice(0, 12)
  const hash = await hashKey(raw)
  return { raw, hash, prefix }
}

export async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}
