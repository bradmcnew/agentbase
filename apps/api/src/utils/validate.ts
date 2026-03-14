import { Context } from 'hono'
import { z } from 'zod'
import { errorResponse, ErrorCode } from './errors'

/**
 * Parse and validate JSON request body against a Zod schema.
 * Returns parsed data or sends a 400 error response.
 */
export async function parseBody<T>(c: Context, schema: z.ZodSchema<T>): Promise<T | Response> {
  const body = await c.req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message || 'Invalid request body')
  }
  return parsed.data
}

/** Safe JSON.parse that returns a fallback on failure instead of throwing */
export function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Parse integer from query param with fallback and bounds */
export function parseIntParam(value: string | undefined, fallback: number, min = 0, max = Infinity): number {
  const n = parseInt(value || '', 10)
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
