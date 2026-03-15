/**
 * HMAC-SHA256 signing for webhook requests.
 * Customers verify the X-AgentPort-Signature header to confirm
 * the request came from AgentPort, not an attacker.
 */

/** Cached HMAC keys per secret (avoids re-importing on every request) */
const keyCache = new Map<string, CryptoKey>()

async function getHmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (key) return key
  key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  keyCache.set(secret, key)
  return key
}

/** Generate HMAC-SHA256 signature for a string payload */
export async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')
}
