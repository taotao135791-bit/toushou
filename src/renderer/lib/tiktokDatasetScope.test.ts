import { describe, expect, it } from 'vitest'
import type { BoardDataset, BoardWidget } from '@shared/types'
import type { TikTokReadingSummary } from '@shared/tiktokReport'
import { combineTikTokScopes, filterTikTokDatasetByScope, nextTikTokScopeExpiry, scopeMatchesWidget, tiktokScopeMatchesDataset, verifiedTikTokScope } from './tiktokDatasetScope'
import { buildTikTokDatasetProofs } from '@shared/tiktokDatasetProof'

const summary: TikTokReadingSummary = {
  range: '7', startDate: '2026-10-24', endDate: '2026-10-30', generatedAt: 1,
  source: 'oauth', transport: 'mcp', datasetSync: { ok: true, proofs: [{ advertiserId: '11', startDate: '2026-10-24', endDate: '2026-10-30', digest: 'a'.repeat(64) }] },
  totals: { spend: 5, impressions: 10, clicks: 2, ctr: .2, conversions: 1, costPerConversion: 5 },
  topCampaigns: [], advertisers: [{ advertiserId: '11', name: 'same', currency: 'USD' }],
  failed: [], currency: 'USD', mixedCurrency: false
}
const dataset: BoardDataset = {
  id: 'test', name: 'TikTok 报表', createdAt: 0,
  columns: [{ name: '日期', type: 'date' }, { name: '广告主ID', type: 'text' }, { name: '消耗', type: 'number' }],
  rows: [['2026-10-24', '11', 5], ['2026-10-23', '11', 100], ['2026-10-24', '22', 700], ['2026-10-31', '11', 80]]
}
const widget: BoardWidget = { id: 'w', type: 'tt-reading', title: '', layout: { x: 0, y: 0, w: 2, h: 2 }, config: { advertiserIds: '', range: '7' } }

describe('TikTok dataset verified scope', () => {
  it('uses only successfully read accounts and the exact report window, excluding historical data', () => {
    const scope = verifiedTikTokScope('w', '', '7', summary)!
    expect(scopeMatchesWidget(scope, [widget], new Date(2026, 9, 31, 12).getTime())).toBe(true)
    expect(filterTikTokDatasetByScope(dataset, scope)?.rows).toEqual([['2026-10-24', '11', 5]])
    expect(scopeMatchesWidget(scope, [{ ...widget, config: { ...widget.config, range: '30' } }])).toBe(false)
    expect(scopeMatchesWidget(scope, [widget, { ...widget, id: 'other' }])).toBe(false)
    expect(scopeMatchesWidget(scope, [])).toBe(false)
  })

  it('expires every relative date window at local midnight', () => {
    const before = new Date(2026, 9, 31, 23, 59, 59, 999).getTime()
    const midnight = new Date(2026, 10, 1, 0, 0, 0, 0).getTime()
    for (const range of ['yd', '3', '7', '28', '30'] as const) {
      const end = new Date(2026, 9, 30)
      const start = new Date(end)
      start.setDate(start.getDate() - (range === 'yd' ? 0 : Number(range) - 1))
      const day = (value: Date) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
      const value = { ...summary, range, startDate: day(start), endDate: day(end), datasetSync: { ok: true as const, proofs: [{ advertiserId: '11', startDate: day(start), endDate: day(end), digest: 'a'.repeat(64) }] } }
      const scope = verifiedTikTokScope('w', '', range, value)!
      const selected = { ...widget, config: { ...widget.config, range } }
      expect(scopeMatchesWidget(scope, [selected], before)).toBe(true)
      expect(nextTikTokScopeExpiry(scope, before)).toBe(midnight)
      expect(scopeMatchesWidget(scope, [selected], midnight)).toBe(false)
    }
  })

  it('uses each account local today, never the latest historical day', () => {
    const today = { ...summary, datasetSync: { ok: true as const, proofs: [{ advertiserId: '11', startDate: '2026-10-31', endDate: '2026-10-31', digest: 'a'.repeat(64) }, { advertiserId: '22', startDate: '2026-10-30', endDate: '2026-10-30', digest: 'b'.repeat(64) }] }, range: '1' as const, startDate: '2026-10-30', endDate: '2026-10-31', advertisers: [...summary.advertisers, { advertiserId: '22', name: 'same', currency: 'USD' }], accountWindows: [{ advertiserId: '11', timezone: 'Asia/Tokyo', startDate: '2026-10-31', endDate: '2026-10-31' }, { advertiserId: '22', timezone: 'America/Los_Angeles', startDate: '2026-10-30', endDate: '2026-10-30' }] }
    const rows = { ...dataset, rows: [['2026-10-31', '11', 1], ['2026-10-30', '11', 9], ['2026-10-30', '22', 2], ['2026-10-29', '22', 8]] }
    const scope = verifiedTikTokScope('w', '', '1', today)!
    expect(filterTikTokDatasetByScope(rows, scope)?.rows).toEqual([['2026-10-31', '11', 1], ['2026-10-30', '22', 2]])
    const instant = Date.parse('2026-10-31T06:30:00Z')
    const todayWidget = { ...widget, config: { ...widget.config, range: '1' } }
    expect(scopeMatchesWidget(scope, [todayWidget], instant)).toBe(true)
    const expiry = nextTikTokScopeExpiry(scope, instant)!
    expect(expiry).toBe(Date.parse('2026-10-31T07:00:00Z'))
    expect(scopeMatchesWidget(scope, [todayWidget], expiry)).toBe(false)
    expect(verifiedTikTokScope('w', '', '1', { ...today, accountWindows: [today.accountWindows[0]] })).toBeNull()
  })

  it('combines 50 accounts, deduplicates overlaps and rejects changed or incompatible evidence', async () => {
    const now = new Date(2026, 9, 31, 12).getTime()
    const ids = Array.from({ length: 50 }, (_, index) => String(index + 1))
    const complete = { ...dataset, rows: ids.map((id) => ['2026-10-25', id, Number(id)]) }
    const windows = ids.map((advertiserId) => ({ advertiserId, startDate: summary.startDate, endDate: summary.endDate }))
    const proofs = await buildTikTokDatasetProofs(complete, windows)
    const makeScope = (id: string, selected: number[]) => verifiedTikTokScope(id, '', '7', { ...summary, advertisers: selected.map((index) => ({ advertiserId: ids[index], name: null, currency: 'USD' })), datasetSync: { ok: true, proofs: selected.map((index) => proofs[index]) } })!
    const a = makeScope('a', Array.from({ length: 30 }, (_, index) => index))
    const b = makeScope('b', Array.from({ length: 30 }, (_, index) => index + 20))
    const widgets = [{ ...widget, id: 'a' }, { ...widget, id: 'b' }]
    const scope = combineTikTokScopes({ a, b }, widgets, now)!
    expect(scope.windows).toHaveLength(50)
    expect(await tiktokScopeMatchesDataset(scope, complete)).toBe(true)
    expect(await tiktokScopeMatchesDataset(scope, { ...complete, rows: [...complete.rows, ['2026-10-25', '999', 500]] })).toBe(true)
    const modified = { ...complete, rows: complete.rows.map((row, index) => index === 0 ? [row[0], row[1], 999] : row) }
    expect(await tiktokScopeMatchesDataset(scope, modified)).toBe(false)
    const divergent = { ...b, proofs: b.proofs.map((proof, index) => index === 0 ? { ...proof, digest: 'f'.repeat(64) } : proof) }
    expect(combineTikTokScopes({ a, b: divergent }, widgets, now)).toBeNull()
    expect(combineTikTokScopes({ a, b: null }, widgets, now)).toBeNull()
  })

  it('refuses partial, failed, truncated, unsaved or identity-less reads', () => {
    for (const value of [
      { ...summary, advertisers: [] },
      { ...summary, failed: [{ advertiserId: '22', name: null, currency: null, error: 'api' as const }] },
      { ...summary, truncated: true },
      { ...summary, datasetSync: { ok: false as const, error: 'write-failed' } },
      { ...summary, datasetSync: undefined }
    ]) expect(verifiedTikTokScope('w', '', '7', value)).toBeNull()
    const scope = verifiedTikTokScope('w', '', '7', summary)!
    expect(filterTikTokDatasetByScope({ ...dataset, columns: [dataset.columns[0]], rows: [] }, scope)).toBeNull()
  })
})
