import { describe, expect, it, vi } from 'vitest'
import type { FbReadingAccountEntry, FbReadingHistoryEntry, FbReadingHistoryRow } from '@shared/fbReading'
import { facebookRowFromEntry, loadTodayFacebookAccounts } from './todayFacebook'

const account: FbReadingAccountEntry = { id: 'a', act: '123456', alias: 'Example', businessId: null, createdAt: 1 }
const second: FbReadingAccountEntry = { id: 'b', act: '234567', alias: 'Other', businessId: null, createdAt: 1 }
function row(overrides: Partial<FbReadingHistoryRow> = {}): FbReadingHistoryRow {
  return { name: 'Campaign', spend: 40, costPerResult: null, cpm: null, impressions: 100, results: 4, resultType: 'app_install', clicks: 10, ctr: null, cpc: null, installs: null, ...overrides }
}
function entry(overrides: Partial<FbReadingHistoryEntry> & { observation?: { currency: string | null } } = {}): FbReadingHistoryEntry {
  return { id: 'r', capturedAt: '2026-11-01T00:00:00.000Z', accountId: account.act, accountName: 'Example', dateRangeLabel: '2026年11月1日', campaignCount: 2, totalSpend: 100, rows: [row(), row({ name: 'Other', spend: 60, results: 6 })], ...overrides }
}

describe('Facebook today reading', () => {
  it('calculates cost per result only when complete rows have one verified result type', () => {
    const current = entry({ observation: { currency: 'USD' } })
    const value = facebookRowFromEntry(account, current, null)
    expect(value).toMatchObject({ spend: 100, currency: 'USD', conversions: 10, resultType: 'app_install', costPerResult: 10, impressions: 200, clicks: 20 })
    for (const secondRow of [row({ resultType: 'purchase' }), row({ resultType: null }), row({ resultType: '' }), row({ results: null })]) {
      expect(facebookRowFromEntry(account, entry({ rows: [row(), secondRow] }), null).costPerResult).toBeNull()
    }
    expect(facebookRowFromEntry(account, entry({ rows: [row({ results: 0 }), row({ results: 0 })] }), null).costPerResult).toBeNull()
  })

  it('leaves partial impressions, clicks and missing campaign data unknown', () => {
    const current = entry({ rows: [row(), row({ name: 'Other', spend: null, impressions: null, clicks: null })] })
    expect(facebookRowFromEntry(account, current, null)).toMatchObject({ impressions: null, clicks: null, movers: [] })
    expect(facebookRowFromEntry(account, entry({ campaignCount: 3 }), null)).toMatchObject({ impressions: null, clicks: null, conversions: null, costPerResult: null })
    expect(facebookRowFromEntry(account, null, null)).toMatchObject({ spend: null, costPerResult: null, capturedAt: null })
  })

  it('does not merge unrelated campaigns merely because their names match', () => {
    const current = entry({ rows: [row(), row({ spend: 60 })], observation: { currency: 'USD' } })
    expect(facebookRowFromEntry(account, current, null).movers).toEqual([])
  })

  it('compares only periods with the same observed currency; old or malformed observations stay unknown', () => {
    const prior = entry({ id: 'prior', totalSpend: 50, observation: { currency: 'USD' } })
    const current = entry({ observation: { currency: 'USD' } })
    expect(facebookRowFromEntry(account, current, prior)).toMatchObject({ currency: 'USD', previousSpend: 50 })
    expect(facebookRowFromEntry(account, entry(), prior)).toMatchObject({ currency: null, previousSpend: null })
    expect(facebookRowFromEntry(account, current, entry({ observation: { currency: 'EUR' } }))).toMatchObject({ currency: 'USD', previousSpend: null })
    expect(facebookRowFromEntry(account, entry({ observation: { currency: '$' } }), prior)).toMatchObject({ currency: null, previousSpend: null })
  })

  it('keeps other accounts visible when one history request fails', async () => {
    const load = vi.fn(async (id: string) => {
      if (id === second.act) throw new Error('offline')
      return [entry()]
    })
    const result = await loadTodayFacebookAccounts([account, second], 'today', load, new Date(2026, 10, 1, 12))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ account, spend: 100, readError: null })
    expect(result[1]).toMatchObject({ account: second, spend: null, readError: 'history-read-failed' })
  })

  it('does not request an unsupported date range or treat malformed history as empty', async () => {
    const load = vi.fn(async () => { throw new Error('unavailable') })
    const unsupported = await loadTodayFacebookAccounts([account], 'last28', load, new Date(2026, 10, 1))
    expect(load).not.toHaveBeenCalled()
    expect(unsupported[0]).toMatchObject({ covered: false, readError: null })
    const malformed = await loadTodayFacebookAccounts([account], 'today', async () => null as unknown as FbReadingHistoryEntry[], new Date(2026, 10, 1))
    expect(malformed[0]).toMatchObject({ covered: true, readError: 'history-read-failed' })
  })
})
