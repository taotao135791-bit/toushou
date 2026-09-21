import {
  boardReadingRangeDates,
  fbReadingMatchesWindow,
  type FbReadingHistoryEntry,
  type FbReadingRange
} from '@shared/fbReading'

/**
 * Bounded per-account retry for FB board readings.
 *
 * Layering: Main performs ONE budgeted read (verified gates intact); the
 * renderer decides whether a failure deserves a second call. Renderer-owned
 * retry = honest "retrying" progress without new IPC progress events, and no
 * hidden duplicate retry inside Main (that used to double weak-network wall
 * time). Verified discipline is untouched — only a result Main already
 * verified for this exact account + date window counts as success.
 */

export const READING_MAX_ATTEMPTS = 2
export const READING_RETRY_DELAY_MS = 2_000

/** Transient page/network failures worth one more verified attempt. */
const RETRYABLE_READING_ERRORS = new Set([
  'unparseable-page',
  'unstable-page',
  'incomplete-view',
  'page-load-failed',
  'navigation-timeout',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED'
])

/**
 * Batch-stopping failures. Login/2FA need a human in the browser panel;
 * browser blocks need the panel or the lock — retrying other accounts right
 * away would only burn the same wall.
 */
const LOGIN_BLOCKING_ERRORS = new Set(['login-required', '2fa-required'])
const BROWSER_BLOCKING_ERRORS = new Set(['browser-busy', 'panel-not-open', 'panel-hidden'])

export type ReadingBlockKind = 'login' | 'browser' | null

export function readingBlockKind(error: string): ReadingBlockKind {
  if (LOGIN_BLOCKING_ERRORS.has(error)) return 'login'
  if (BROWSER_BLOCKING_ERRORS.has(error)) return 'browser'
  return null
}

export type ReadingAttemptStatus = 'reading' | 'retrying'

export interface ReadingAttemptProgress {
  status: ReadingAttemptStatus
  attempt: number
  lastError?: string
  /** Epoch ms when the next attempt starts (backoff countdown). */
  retryAt?: number
}

export type AccountReadingOutcome =
  | { kind: 'ok'; entry: FbReadingHistoryEntry }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' }

export interface ReadingRetryOptions {
  isCurrent: () => boolean
  onProgress?: (progress: ReadingAttemptProgress) => void
  invoke?: typeof window.electronAPI.refreshFbReading
}

function delayWithCancel(ms: number, isCurrent: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (!isCurrent() || Date.now() - startedAt >= ms) {
        clearInterval(timer)
        resolve(!isCurrent())
      }
    }, 200)
  })
}

/**
 * One account: at most two IPC calls separated by a fixed backoff. Success
 * requires Main's verified entry to still match this batch's account and
 * date window; anything else is a precise failure (never silent data).
 */
export async function refreshAccountWithRetry(
  params: { alias: string; act: string; businessId: string | null; range: FbReadingRange },
  options: ReadingRetryOptions
): Promise<AccountReadingOutcome> {
  const invoke = options.invoke ?? window.electronAPI.refreshFbReading
  // The batch's window is fixed when the batch starts, so a refresh that
  // crosses midnight returns data for the window the user clicked on.
  const expectedWindow = boardReadingRangeDates(params.range)
  for (let attempt = 1; attempt <= READING_MAX_ATTEMPTS; attempt += 1) {
    if (!options.isCurrent()) return { kind: 'cancelled' }
    options.onProgress?.({ status: attempt === 1 ? 'reading' : 'retrying', attempt })
    let result: Awaited<ReturnType<typeof invoke>>
    try {
      result = await invoke(params)
    } catch {
      result = { ok: false, error: 'invoke-failed' }
    }
    if (!options.isCurrent()) return { kind: 'cancelled' }
    if (result.ok) {
      const entry = result.entry
      const matches = entry.accountId === params.act && fbReadingMatchesWindow(entry, params.act, expectedWindow)
      return matches ? { kind: 'ok', entry } : { kind: 'failed', error: 'date-mismatch' }
    }
    if (attempt < READING_MAX_ATTEMPTS && RETRYABLE_READING_ERRORS.has(result.error)) {
      options.onProgress?.({
        status: 'retrying',
        attempt: attempt + 1,
        lastError: result.error,
        retryAt: Date.now() + READING_RETRY_DELAY_MS
      })
      const cancelled = await delayWithCancel(READING_RETRY_DELAY_MS, options.isCurrent)
      if (cancelled || !options.isCurrent()) return { kind: 'cancelled' }
      continue
    }
    return { kind: 'failed', error: result.error }
  }
  return { kind: 'failed', error: 'refresh-failed' }
}

