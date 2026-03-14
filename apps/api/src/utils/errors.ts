import { Context } from 'hono'

export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  ENDPOINT_PAUSED: 'ENDPOINT_PAUSED',
  SEARCH_ERROR: 'SEARCH_ERROR',
  INDEXING_ERROR: 'INDEXING_ERROR',
  QUERY_ERROR: 'QUERY_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
} as const

type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode]

export function errorResponse(c: Context, status: number, code: ErrorCodeType, message: string) {
  return c.json({ error: { code, message } }, status as any)
}

/** Log the real error, return a sanitized message to the user */
export function serviceError(c: Context, code: ErrorCodeType, userMessage: string, err: unknown) {
  console.error(`${code}:`, err instanceof Error ? err.message : err)
  return errorResponse(c, 502, code, userMessage)
}
