/**
 * HMAC-SHA256 signing for webhook requests.
 * Customers verify the X-AgentPort-Signature header to confirm
 * the request came from AgentPort, not an attacker.
 */

/** Generate HMAC-SHA256 signature for a string payload */
export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')
}
