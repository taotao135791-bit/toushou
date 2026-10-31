import { describe, expect, it } from 'vitest'
import type { TikTokTodayReading } from '@shared/todayReading'
import { mergeSingleTikTokReading } from './tiktokAccountRefresh'

const base: TikTokTodayReading = { range: 'last7', window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: { start: '2026-09-24', end: '2026-09-30' }, source: 'oauth', generatedAt: 1, truncated: false, accounts: [
  { advertiserId: '11', name: 'A', currency: 'USD', spend: 1, previousSpend: 0, impressions: 1, clicks: 1, conversions: 1, campaigns: [] },
  { advertiserId: '22', name: 'B', currency: 'USD', spend: 2, previousSpend: 0, impressions: 2, clicks: 2, conversions: 2, campaigns: [] }
] }

describe('single account refresh merge', () => {
  it('updates only the requested account and preserves the original page window and other row', () => {
    const selected = { ...base.accounts[0], spend: 15 }
    const result = mergeSingleTikTokReading(base, { ...base, accounts: [selected] }, '11')!
    expect(result.accounts[0]).toMatchObject({ advertiserId: '11', spend: 15, window: base.window })
    expect(result.accounts[1]).toEqual(base.accounts[1])
    expect(result.generatedAt).toBe(base.generatedAt)
  })
  it('refuses other accounts, mixed results, failed reads and changed ranges', () => {
    expect(mergeSingleTikTokReading(base, { ...base, accounts: [base.accounts[1]] }, '11')).toBeNull()
    expect(mergeSingleTikTokReading(base, base, '11')).toBeNull()
    expect(mergeSingleTikTokReading(base, { ...base, accounts: [{ advertiserId: '11', name: null, currency: null, error: 'network' }] }, '11')).toBeNull()
    expect(mergeSingleTikTokReading(base, { ...base, range: 'today', accounts: [base.accounts[0]] }, '11')).toBeNull()
  })
})
