import { describe, expect, it } from 'vitest'
import type { TikTokTodayAccountReading, TikTokTodayReading } from '@shared/todayReading'
import { isTikTokAccountCurrent } from './readingFreshness'

const now = Date.parse('2026-11-01T06:30:00Z')
const account: TikTokTodayAccountReading = {
  advertiserId: '123', name: 'Example', currency: 'USD', timezone: 'America/Los_Angeles',
  window: { start: '2026-10-24', end: '2026-10-30' }, previousWindow: { start: '2026-10-17', end: '2026-10-23' },
  spend: 2, previousSpend: 1, impressions: 3, clicks: 1, conversions: 1, campaigns: []
}
const reading: TikTokTodayReading = { range: 'last7', window: account.window!, previousWindow: account.previousWindow!, source: 'oauth', generatedAt: now, truncated: false, accounts: [account] }

describe('TT reading freshness', () => {
  it('checks each account timezone rather than the machine calendar date', () => {
    expect(isTikTokAccountCurrent(account, reading, 'last7', undefined, now)).toBe(true)
    expect(isTikTokAccountCurrent({ ...account, timezone: 'Asia/Tokyo' }, reading, 'last7', undefined, now)).toBe(false)
    expect(isTikTokAccountCurrent({ ...account, timezone: undefined }, reading, 'last7', undefined, now)).toBe(false)
    expect(isTikTokAccountCurrent({ ...account, window: undefined }, reading, 'last7', undefined, now)).toBe(false)
    expect(isTikTokAccountCurrent({ ...account, previousWindow: { start: '2026-10-16', end: '2026-10-23' } }, reading, 'last7', undefined, now)).toBe(false)
    expect(isTikTokAccountCurrent(account, reading, 'last7', undefined, now + 86_400_000)).toBe(false)
  })
  it('requires the exact valid explicit custom range, including per-account future check', () => {
    const custom = { start: '2026-10-01', end: '2026-10-03' }
    const selected = { ...account, window: custom, previousWindow: { start: '2026-09-28', end: '2026-09-30' } }
    const source = { ...reading, range: 'custom' as const, window: custom, accounts: [selected] }
    expect(isTikTokAccountCurrent(selected, source, 'custom', custom, now)).toBe(true)
    expect(isTikTokAccountCurrent(selected, source, 'custom', { start: '2026-10-02', end: '2026-10-03' }, now)).toBe(false)
    expect(isTikTokAccountCurrent(selected, source, 'custom', undefined, now)).toBe(false)
    const future = { start: '2026-11-01', end: '2026-11-01' }
    expect(isTikTokAccountCurrent({ ...selected, window: future }, source, 'custom', future, now)).toBe(false)
    expect(isTikTokAccountCurrent(selected, source, 'last7', undefined, now)).toBe(false)
  })
})
