import { describe, expect, it } from 'vitest'
import type { TikTokTodayReading } from '@shared/todayReading'
import { buildTikTokPageRead, matchesTikTokPageRead, scopeTikTokPageData } from './tiktokTodayScope'

const one = { kind: 'one' as const, advertiserId: '7300000000000000001' }
const all = { kind: 'all' as const }
const reading: TikTokTodayReading = { range: 'last7', window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: { start: '2026-09-24', end: '2026-09-30' }, source: 'oauth', generatedAt: 1, truncated: false, accounts: [{ advertiserId: one.advertiserId, name: null, currency: null, error: 'network' }] }

describe('Today TikTok reading scope', () => {
  it('makes no report request until the user chooses a scope', () => {
    expect(buildTikTokPageRead(null, 'last7', 'request')).toBeNull()
  })
  it('keeps a single advertiser on retries and date switches without expanding to all', () => {
    expect(buildTikTokPageRead(one, 'last7', 'a')).toEqual({ range: 'last7', requestId: 'a', advertiserId: one.advertiserId })
    expect(buildTikTokPageRead(one, 'today', 'b')).toEqual({ range: 'today', requestId: 'b', advertiserId: one.advertiserId })
    expect(buildTikTokPageRead(all, 'today', 'c')).toEqual({ range: 'today', requestId: 'c' })
  })
  it('shows only the selected account and excludes a failed refresh from the overall draft', () => {
    const second = { ...reading.accounts[0], advertiserId: '7300000000000000002' }
    const both = { ...reading, accounts: [reading.accounts[0], second] }
    expect(scopeTikTokPageData(both, one)?.accounts.map((account) => account.advertiserId)).toEqual([one.advertiserId])
    expect(scopeTikTokPageData(both, one, new Set([one.advertiserId]))?.accounts).toEqual([])
    expect(scopeTikTokPageData(both, all, new Set([one.advertiserId]))?.accounts.map((account) => account.advertiserId)).toEqual([second.advertiserId])
    expect(both.accounts).toHaveLength(2)
  })

  it('rejects another account, multiple accounts, or a stale date range for a single selection', () => {
    expect(matchesTikTokPageRead(one, 'last7', reading)).toBe(true)
    expect(matchesTikTokPageRead(one, 'today', reading)).toBe(false)
    expect(matchesTikTokPageRead(one, 'last7', { ...reading, accounts: [{ ...reading.accounts[0], advertiserId: '999' }] })).toBe(false)
    expect(matchesTikTokPageRead(one, 'last7', { ...reading, accounts: [...reading.accounts, { ...reading.accounts[0], advertiserId: '999' }] })).toBe(false)
  })
})
