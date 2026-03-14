/** Generate a random hex ID (UUID without hyphens) */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
