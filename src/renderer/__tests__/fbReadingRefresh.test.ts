import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardReadingRangeDates } from '@shared/fbReading'
import type { FbReadingHistoryEntry } from '@shared/fbReading'
import { readingBlockKind, refreshAccountWithRetry } from '../pages/boards/fbReadingRefresh'

const ACT = '2131017261144314'
const PARAMS = { alias: '三国IOS', act: ACT, businessId: '1734414010144999', range: 'today' as const }

/** A verified-shaped entry whose visible label matches today's window. */
function entryFor(act: string = ACT, dayOffset = 0): FbReadingHistoryEntry {
  const { start } = boardReadingRangeDates('today')
  const [y, m, d] = start.split('-').map(Number)
  const shifted = new Date(y, m - 1, d + dayOffset)
  const label = `今天：${shifted.getFullYear()}年${shifted.getMonth() + 1}月${shifted.getDate()}日`
  return {
    id: 'entry-1',
    capturedAt: new Date().toISOString(),
    accountId: act,
    accountName: null,
    dateRangeLabel: label,
    campaignCount: 2,
    totalSpend: 12.5,
    rows: []
  }
}

type Invoke = NonNullable<Parameters<typeof refreshAccountWithRetry>[1]['invoke']>
type InvokeResult = Awaited<ReturnType<Invoke>>

function invokeOf(results: InvokeResult[]): Invoke {
  return vi.fn(async () => results.shift() ?? { ok: false, error: 'unexpected' }) as Invoke
}

describe('refreshAccountWithRetry (bounded renderer retry)', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('retries a transient unparseable-page once and returns the verified entry', async () => {
    vi.useFakeTimers()
    const expected = entryFor()
    const invoke = invokeOf([
      { ok: false, error: 'unparseable-page' },
      { ok: true, entry: expected }
    ])
    const progress: string[] = []
    const pending = refreshAccountWithRetry(PARAMS, {
      isCurrent: () => true,
      invoke,
      onProgress: (next) => progress.push(next.status + ':' + next.attempt)
    })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(await pending).toEqual({ kind: 'ok', entry: expected })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(['reading:1', 'retrying:2', 'retrying:2'])
  })

  it('gives up after the second failed attempt (max two calls total)', async () => {
    vi.useFakeTimers()
    const invoke = invokeOf([
      { ok: false, error: 'unparseable-page' },
      { ok: false, error: 'unparseable-page' }
    ])
    const pending = refreshAccountWithRetry(PARAMS, { isCurrent: () => true, invoke })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(await pending).toEqual({ kind: 'failed', error: 'unparseable-page' })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('never retries login, date mismatch, storage or invoke failures', async () => {
    for (const error of ['login-required', 'date-mismatch', 'browser-busy', 'not-stored:find-failed', 'refresh-timeout']) {
      const invoke = invokeOf([{ ok: false, error }])
      const outcome = await refreshAccountWithRetry(PARAMS, { isCurrent: () => true, invoke })
      expect(outcome).toEqual({ kind: 'failed', error })
      expect(invoke).toHaveBeenCalledTimes(1)
    }
    const throwing = vi.fn(async () => { throw new Error('ipc down') }) as unknown as Invoke
    const outcome = await refreshAccountWithRetry(PARAMS, { isCurrent: () => true, invoke: throwing })
    expect(outcome).toEqual({ kind: 'failed', error: 'invoke-failed' })
    expect(throwing).toHaveBeenCalledTimes(1)
  })

  it('refuses a verified-looking entry for another account or window', async () => {
    const invoke = invokeOf([{ ok: true, entry: entryFor('27893958520273993') }])
    expect(await refreshAccountWithRetry(PARAMS, { isCurrent: () => true, invoke }))
      .toEqual({ kind: 'failed', error: 'date-mismatch' })
    const otherDay = invokeOf([{ ok: true, entry: entryFor(ACT, 1) }])
    expect(await refreshAccountWithRetry(PARAMS, { isCurrent: () => true, invoke: otherDay }))
      .toEqual({ kind: 'failed', error: 'date-mismatch' })
  })

  it('stops waiting and returns cancelled once the batch is superseded', async () => {
    vi.useFakeTimers()
    let current = true
    const invoke = invokeOf([{ ok: false, error: 'page-load-failed' }])
    const pending = refreshAccountWithRetry(PARAMS, { isCurrent: () => current, invoke })
    current = false
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('classifies batch-stopping blocks', () => {
    expect(readingBlockKind('login-required')).toBe('login')
    expect(readingBlockKind('2fa-required')).toBe('login')
    expect(readingBlockKind('browser-busy')).toBe('browser')
    expect(readingBlockKind('panel-not-open')).toBe('browser')
    expect(readingBlockKind('panel-hidden')).toBe('browser')
    expect(readingBlockKind('unparseable-page')).toBeNull()
    expect(readingBlockKind('date-mismatch')).toBeNull()
  })
})
