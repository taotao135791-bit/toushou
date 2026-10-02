import { beforeEach, describe, expect, it, vi } from 'vitest'

// buildTikTokReadingSummary pulls the client + resolver chains, which import
// electron-backed stores at module level — stub like the sibling suites.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' } }))

import { isTikTokTodayFailure } from '../../../shared/todayReading'
import type { TikTokReportRow } from './tiktokClient'
import {
  buildTikTokReadingSummary,
  buildTikTokTodayReading,
  resetTikTokAdvertiserInfoCacheForTest,
  summarizeTikTokReportRows,
  TODAY_ADVERTISER_CAP
} from './tiktokReading'
import type { ResolvedTikTokToken } from './resolveTikTokToken'

const ID_A = '7300000000000000001'
const ID_B = '7300000000000000002'

function row(overrides: Partial<TikTokReportRow> = {}): TikTokReportRow {
  return {
    date: '2026-01-02',
    campaignName: 'C1',
    spend: 10,
    impressions: 1000,
    clicks: 50,
    ctr: 0.05,
    cpc: 0.2,
    conversion: 2,
    costPerConversion: 5,
    ...overrides
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

function reportResponse(rows: TikTokReportRow[]): Response {
  return jsonResponse({
    code: 0,
    message: 'OK',
    data: {
      list: rows.map((row, index) => ({
        dimensions: { campaign_id: String(1800 + index), stat_time_day: `${row.date} 00:00:00` },
        metrics: {
          campaign_name: row.campaignName,
          spend: String(row.spend ?? 0),
          impressions: String(row.impressions ?? 0),
          clicks: String(row.clicks ?? 0),
          ctr: String(row.ctr ?? 0),
          cpc: String(row.cpc ?? 0),
          conversion: String(row.conversion ?? 0),
          cost_per_conversion: String(row.costPerConversion ?? 0)
        }
      })),
      page_info: { total_page: 1 }
    }
  })
}

function apiError(code: number, message: string): Response {
  return jsonResponse({ code, message, data: {} })
}

interface Advertiser {
  name?: string
  currency?: string
}

/**
 * Routes the two GET endpoints the reading uses. `report` answers per
 * advertiser id; `advertisers` is what /advertiser/info/ knows.
 */
function tiktokApi(options: {
  report: (advertiserId: string, params: URLSearchParams) => Response
  advertisers?: Record<string, Advertiser>
  infoFails?: boolean
}) {
  const reports: URLSearchParams[] = []
  const infoCalls: string[][] = []
  const methods: Array<string | undefined> = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    methods.push(init?.method)
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/advertiser/info/')) {
      const ids = JSON.parse(parsed.searchParams.get('advertiser_ids') ?? '[]') as string[]
      infoCalls.push(ids)
      if (options.infoFails) return apiError(50000, 'System error')
      const known = options.advertisers ?? {}
      return jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          list: ids
            .filter((id) => known[id])
            .map((id) => ({ advertiser_id: id, name: known[id].name ?? '', currency: known[id].currency ?? '' }))
        }
      })
    }
    reports.push(parsed.searchParams)
    return options.report(parsed.searchParams.get('advertiser_id') ?? '', parsed.searchParams)
  }
  return { fetchImpl, reports, infoCalls, methods }
}

const token = (advertiserIds: string[], source: 'oauth' | 'pasted' = 'oauth'): (() => Promise<ResolvedTikTokToken>) =>
  async () => ({ token: `${source}-token`, source, advertiserIds })

/** 2026-09-20 noon, local time. */
const SEP_20 = () => new Date(2026, 8, 20, 12).getTime()

beforeEach(() => {
  resetTikTokAdvertiserInfoCacheForTest()
})

describe('summarizeTikTokReportRows', () => {
  it('sums additive metrics and recomputes ctr / cost-per-conversion', () => {
    const { totals } = summarizeTikTokReportRows([
      row({ spend: 10, impressions: 1000, clicks: 50, conversion: 2 }),
      // Per-row ctr differs; the total must come from summed denominators.
      row({ campaignName: 'C2', spend: 30, impressions: 1000, clicks: 10, ctr: 0.01, conversion: 0 }),
      // Null cells count as zero, never poison the sums.
      row({ campaignName: 'C3', spend: null, impressions: null, clicks: null, conversion: null })
    ])
    expect(totals.spend).toBe(40)
    expect(totals.impressions).toBe(2000)
    expect(totals.clicks).toBe(60)
    expect(totals.ctr).toBeCloseTo(0.03, 10) // 60 / 2000, NOT the row average
    expect(totals.conversions).toBe(2)
    expect(totals.costPerConversion).toBeCloseTo(20, 10) // 40 / 2
  })

  it('returns zero totals and no campaigns for an empty row set', () => {
    const { totals, topCampaigns } = summarizeTikTokReportRows([])
    expect(totals).toEqual({ spend: 0, impressions: 0, clicks: 0, ctr: 0, conversions: 0, costPerConversion: 0 })
    expect(topCampaigns).toEqual([])
  })

  it('groups campaigns by name and keeps the top 5 by spend', () => {
    const rows = [
      row({ campaignName: 'A', spend: 50 }),
      row({ campaignName: 'A', spend: 25 }), // same campaign, summed
      ...['B', 'C', 'D', 'E', 'F', 'G'].map((name, index) =>
        row({ campaignName: name, spend: 20 - index })
      )
    ]
    const { topCampaigns } = summarizeTikTokReportRows(rows)
    expect(topCampaigns).toHaveLength(5)
    expect(topCampaigns[0]).toEqual({
      name: 'A',
      spend: 75,
      impressions: 2000,
      clicks: 100,
      conversions: 4
    })
    expect(topCampaigns.map((campaign) => campaign.name)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })
})

describe('buildTikTokReadingSummary', () => {
  it('returns the stable no-credentials error when no token source answers', async () => {
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokReadingSummary(
      {},
      { resolveToken: async () => ({ token: null, source: 'none' }), fetchImpl: api.fetchImpl }
    )
    expect(result).toEqual({ ok: false, error: 'no-credentials' })
    expect(api.methods).toHaveLength(0)
  })

  it('sends nothing and asks for an advertiser when none is known', async () => {
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([], 'pasted'), fetchImpl: api.fetchImpl })
    expect(result).toEqual({ ok: false, error: 'no-advertiser' })
    expect(api.methods).toHaveLength(0)
  })

  it('reads each advertiser over GET for complete days ending yesterday', async () => {
    const api = tiktokApi({
      report: (id) => reportResponse([row({ campaignName: id === ID_A ? 'A' : 'B', spend: 12.5 })]),
      advertisers: { [ID_A]: { name: '三国 iOS', currency: 'USD' }, [ID_B]: { name: 'Global', currency: 'USD' } }
    })
    const result = await buildTikTokReadingSummary(
      { range: '7' },
      { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: SEP_20 }
    )
    if ('ok' in result) throw new Error(`expected a summary, got ${result.error}`)
    expect(result.totals.spend).toBe(25)
    expect(result.range).toBe('7')
    expect(result.startDate).toBe('2026-09-13')
    expect(result.endDate).toBe('2026-09-19')
    expect(result.source).toBe('oauth')
    expect(result.topCampaigns.map((campaign) => campaign.name)).toEqual(['A', 'B'])
    expect(result.advertisers).toEqual([
      { advertiserId: ID_A, name: '三国 iOS', currency: 'USD' },
      { advertiserId: ID_B, name: 'Global', currency: 'USD' }
    ])
    expect(result.failed).toEqual([])
    expect(result.currency).toBe('USD')
    expect(result.mixedCurrency).toBe(false)

    expect(api.methods.every((method) => method === 'GET')).toBe(true)
    expect(api.reports.map((params) => params.get('advertiser_id'))).toEqual([ID_A, ID_B])
    expect(api.reports.every((params) => params.get('start_date') === '2026-09-13')).toBe(true)
    expect(api.reports.every((params) => params.get('end_date') === '2026-09-19')).toBe(true)
  })

  it('reads only today for the 1-day range', async () => {
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokReadingSummary(
      { range: '1' },
      { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 }
    )
    if ('ok' in result) throw new Error(result.error)
    expect([result.startDate, result.endDate]).toEqual(['2026-09-20', '2026-09-20'])
  })

  it('lets the widget config override the advertiser scope', async () => {
    const api = tiktokApi({ report: () => reportResponse([row()]) })
    const result = await buildTikTokReadingSummary(
      { advertiserIds: '7399999999999999999', range: '1' },
      { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl }
    )
    if ('ok' in result) throw new Error(`expected a summary, got ${result.error}`)
    expect(api.reports.map((params) => params.get('advertiser_id'))).toEqual(['7399999999999999999'])
  })

  it('treats an empty widget list as "use the Connections list"', async () => {
    const api = tiktokApi({ report: () => reportResponse([row()]) })
    const result = await buildTikTokReadingSummary(
      { advertiserIds: '  ' },
      { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl }
    )
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports.map((params) => params.get('advertiser_id'))).toEqual([ID_A])
  })

  it('rejects a malformed widget list before any request', async () => {
    const api = tiktokApi({ report: () => reportResponse([row()]) })
    for (const advertiserIds of ['7300001; drop table', 7300001, '7'.repeat(401)]) {
      const result = await buildTikTokReadingSummary({ advertiserIds }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
      expect(result).toEqual({ ok: false, error: 'invalid-input' })
    }
    expect(api.methods).toHaveLength(0)
  })

  it('marks only the advertiser that failed and still adds up the rest', async () => {
    const api = tiktokApi({
      report: (id) => (id === ID_B ? apiError(40001, 'No permission to operate') : reportResponse([row({ spend: 7 })])),
      advertisers: { [ID_A]: { name: 'Main', currency: 'USD' }, [ID_B]: { name: 'Locked', currency: 'USD' } }
    })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(result.totals.spend).toBe(7)
    expect(result.advertisers.map((advertiser) => advertiser.advertiserId)).toEqual([ID_A])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ advertiserId: ID_B, name: 'Locked', error: 'permission' })
    expect(result.failed[0].detail).toContain('40001')
  })

  it('stops the whole read when the token itself is rejected', async () => {
    const api = tiktokApi({ report: () => apiError(40105, 'Access token is incorrect or has been revoked') })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl })
    expect(result).toMatchObject({ ok: false, error: 'auth' })
    expect(api.reports).toHaveLength(1)
  })

  it('stops the whole read when TikTok cannot be reached', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl })
    expect(result).toMatchObject({ ok: false, error: 'network' })
  })

  it('reports the shared reason when every advertiser fails on its own', async () => {
    const api = tiktokApi({ report: () => apiError(40001, 'No permission to operate') })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl })
    expect(result).toMatchObject({ ok: false, error: 'permission' })
    if (!('ok' in result)) throw new Error('expected a failure')
    expect(result.detail).toContain('40001')
    expect(api.reports).toHaveLength(2)
  })

  it('does not name a currency when accounts disagree or one is unknown', async () => {
    const mixed = tiktokApi({
      report: () => reportResponse([row()]),
      advertisers: { [ID_A]: { currency: 'USD' }, [ID_B]: { currency: 'EUR' } }
    })
    const mixedResult = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: mixed.fetchImpl })
    if ('ok' in mixedResult) throw new Error(mixedResult.error)
    expect(mixedResult.currency).toBeNull()
    expect(mixedResult.mixedCurrency).toBe(true)

    resetTikTokAdvertiserInfoCacheForTest()
    const partial = tiktokApi({ report: () => reportResponse([row()]), advertisers: { [ID_A]: { currency: 'USD' } } })
    const partialResult = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: partial.fetchImpl })
    if ('ok' in partialResult) throw new Error(partialResult.error)
    expect(partialResult.currency).toBeNull()
    expect(partialResult.mixedCurrency).toBe(false)
  })

  it('still reads when advertiser names cannot be looked up', async () => {
    const api = tiktokApi({ report: () => reportResponse([row({ spend: 3 })]), infoFails: true })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(result.totals.spend).toBe(3)
    expect(result.advertisers).toEqual([{ advertiserId: ID_A, name: null, currency: null }])
  })

  it('caches advertiser names between reads', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: { [ID_A]: { name: 'Main', currency: 'USD' } } })
    await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 })
    await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 })
    expect(api.infoCalls).toEqual([[ID_A]])
  })
})

describe('buildTikTokTodayReading', () => {
  it('splits one report pull into the current window and the previous one', async () => {
    const api = tiktokApi({
      report: () =>
        reportResponse([
          row({ date: '2026-09-30', campaignName: 'A', spend: 10, impressions: 100, clicks: 5, conversion: 1 }),
          row({ date: '2026-09-20', campaignName: 'A', spend: 4, impressions: 40, clicks: 2, conversion: 0 }),
          row({ date: '2026-09-20', campaignName: 'B', spend: 30, impressions: 10, clicks: 1, conversion: 0 })
        ]),
      advertisers: { [ID_A]: { name: 'Main', currency: 'USD' } }
    })
    const result = await buildTikTokTodayReading(
      { range: 'last7' },
      { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: () => new Date(2026, 9, 1, 12).getTime() }
    )
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports[0].get('advertiser_id')).toBe(ID_A)
    expect(api.reports[0].get('start_date')).toBe('2026-09-17')
    expect(api.reports[0].get('end_date')).toBe('2026-09-30')
    expect(result.window).toEqual({ start: '2026-09-24', end: '2026-09-30' })
    expect(result.accounts).toHaveLength(1)
    const account = result.accounts[0]
    if (isTikTokTodayFailure(account)) throw new Error(account.error)
    expect(account).toMatchObject({ advertiserId: ID_A, name: 'Main', currency: 'USD' })
    expect(account.spend).toBe(10)
    expect(account.previousSpend).toBe(34)
    expect(account.campaigns.map((campaign) => campaign.name)).toEqual(['B', 'A'])
  })

  it('sends nothing and asks for an advertiser when none is known', async () => {
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({}, { resolveToken: token([]), fetchImpl: api.fetchImpl })
    expect(result).toEqual({ ok: false, error: 'no-advertiser' })
    expect(api.methods).toHaveLength(0)
  })

  it('keeps a failed advertiser as its own row', async () => {
    const api = tiktokApi({
      report: (id) => (id === ID_B ? apiError(40001, 'No permission to operate') : reportResponse([row({ date: '2026-09-19' })]))
    })
    const result = await buildTikTokTodayReading({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: SEP_20 })
    if ('ok' in result) throw new Error(result.error)
    expect(result.accounts.map((account) => (isTikTokTodayFailure(account) ? account.error : 'ok'))).toEqual(['ok', 'permission'])
    expect(result.accounts[1].advertiserId).toBe(ID_B)
  })

  it('fails the whole page when the token is rejected', async () => {
    const api = tiktokApi({ report: () => apiError(40104, 'Access token is empty') })
    const result = await buildTikTokTodayReading({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl })
    expect(result).toMatchObject({ ok: false, error: 'auth' })
    expect(api.reports).toHaveLength(1)
  })

  it(`reads at most ${TODAY_ADVERTISER_CAP} advertisers and says so`, async () => {
    const ids = Array.from({ length: TODAY_ADVERTISER_CAP + 1 }, (_, index) => String(7300000000 + index))
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({}, { resolveToken: token(ids), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports).toHaveLength(TODAY_ADVERTISER_CAP)
    expect(result.truncated).toBe(true)
  })
})
