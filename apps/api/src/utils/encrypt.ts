/**
 * AES-256-GCM encryption for sensitive data (BYOK API keys).
 * Uses a platform-level secret as the encryption key.
 * Format: base64(iv:ciphertext:tag)
 */

const ALGO = 'AES-GCM'
const IV_LENGTH = 12  // 96-bit IV for GCM

/** Derive a 256-bit key from a string secret */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('agentport-v1'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Encrypt a plaintext string. Returns a base64-encoded string. */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded)

  // Combine iv + ciphertext into one buffer, then base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return btoa(String.fromCharCode(...combined))
}

/** Decrypt a base64-encoded ciphertext. Returns the plaintext string. */
export async function decrypt(ciphertextB64: string, secret: string): Promise<string> {
  const key = await deriveKey(secret)
  const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0))

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}
