/**
 * Stable reasons a reading failed. Main classifies the failure; the renderer
 * turns each code into plain words and one next step. `detail` carries the
 * raw text for the collapsed technical details and is never the headline.
 */
export type ReadingErrorCode =
  | 'no-credentials'
  | 'no-advertiser'
  | 'auth'
  | 'permission'
  | 'rate-limit'
  | 'network'
  | 'api'
  | 'invalid-input'

export interface ReadingFailure {
  ok: false
  error: ReadingErrorCode
  detail?: string
}

export const READING_ERROR_DETAIL_LIMIT = 300

const CODES: readonly ReadingErrorCode[] = [
  'no-credentials',
  'no-advertiser',
  'auth',
  'permission',
  'rate-limit',
  'network',
  'api',
  'invalid-input'
]

export function isReadingErrorCode(value: unknown): value is ReadingErrorCode {
  return typeof value === 'string' && (CODES as readonly string[]).includes(value)
}

export function readingFailure(error: ReadingErrorCode, detail?: string): ReadingFailure {
  const bounded = detail?.trim().slice(0, READING_ERROR_DETAIL_LIMIT)
  return bounded ? { ok: false, error, detail: bounded } : { ok: false, error }
}
