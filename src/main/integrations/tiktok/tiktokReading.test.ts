import { describe, expect, it, vi } from 'vitest'

// buildTikTokReadingSummary pulls the client + resolver chains, which import
// electron-backed stores at module level — stub like the sibling suites.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' } }))

import type { TikTokReportRow } from './tiktokClient'
import {
  buildTikTokReadingSummary,
  parseTikTokReadingAdvertiserIds,
  summarizeTikTokReportRows,
  tiktokReadingRangeWindow
} from './tiktokReading'
import type { ResolvedTikTokToken } from './resolveTikTokToken'

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
      list: rows.map((row) => ({
        dimensions: { stat_time_day: row.date, campaign_name: row.campaignName },
        metrics: {
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
    expect(topCampaigns[0]).toEqual({ name: 'A', spend: 75 })
    expect(topCampaigns.map((campaign) => campaign.name)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })
})

describe('tiktokReadingRangeWindow', () => {
  it('builds inclusive local windows ending today', () => {
    const today = new Date(2026, 8, 20) // local 2026-09-20
    expect(tiktokReadingRangeWindow('1', today)).toEqual({ startDate: '2026-09-20', endDate: '2026-09-20' })
    expect(tiktokReadingRangeWindow('7', today)).toEqual({ startDate: '2026-09-14', endDate: '2026-09-20' })
    expect(tiktokReadingRangeWindow('28', today)).toEqual({ startDate: '2026-08-24', endDate: '2026-09-20' })
  })
})

describe('parseTikTokReadingAdvertiserIds', () => {
  it('treats absent and empty lists as "use the grant"', () => {
    expect(parseTikTokReadingAdvertiserIds(undefined)).toBeNull()
    expect(parseTikTokReadingAdvertiserIds('')).toBeNull()
    expect(parseTikTokReadingAdvertiserIds(' , ；')).toBeNull()
  })

  it('parses comma / CJK-comma separated positive ids and de-duplicates', () => {
    expect(parseTikTokReadingAdvertiserIds('7300001, 7300002，7300001')).toEqual([7300001, 7300002])
  })

  it('rejects non-strings, overlong input and non-numeric characters', () => {
    expect(parseTikTokReadingAdvertiserIds(7300001)).toBeNull()
    expect(parseTikTokReadingAdvertiserIds('7300001; drop table')).toBeNull()
    expect(parseTikTokReadingAdvertiserIds('7300001\n7300002')).toBeNull()
    expect(parseTikTokReadingAdvertiserIds('7'.repeat(401))).toBeNull()
  })
})

describe('buildTikTokReadingSummary', () => {
  const oauthToken: ResolvedTikTokToken = {
    token: 'oauth-token',
    source: 'oauth',
    advertiserIds: [7300001, 7300002]
  }

  it('returns the stable no-credentials error when no token source answers', async () => {
    const result = await buildTikTokReadingSummary(
      {},
      { resolveToken: async () => ({ token: null, source: 'none' }) }
    )
    expect(result).toEqual({ ok: false, error: 'no-credentials' })
  })

  it('queries each granted advertiser and aggregates the merged rows', async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      return reportResponse([row({ campaignName: Number(body.advertiser_id) === 7300001 ? 'A' : 'B', spend: 12.5 })])
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const result = await buildTikTokReadingSummary(
      { range: '7' },
      {
        resolveToken: async () => oauthToken,
        fetchImpl,
        now: () => new Date(2026, 8, 20, 12).getTime()
      }
    )
    if (!('ok' in result)) {
      expect(result.totals.spend).toBe(25)
      expect(result.range).toBe('7')
      expect(result.startDate).toBe('2026-09-14')
      expect(result.endDate).toBe('2026-09-20')
      expect(result.source).toBe('oauth')
      expect(result.topCampaigns.map((campaign) => campaign.name)).toEqual(['A', 'B'])
    } else {
      throw new Error(`expected a summary, got ${result.error}`)
    }
    // One query per granted advertiser, scoped + dated.
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.advertiser_id)).toEqual([7300001, 7300002])
  })

  it('lets the widget config override the advertiser scope', async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return reportResponse([row()])
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const result = await buildTikTokReadingSummary(
      { advertiserIds: '7399999', range: '1' },
      { resolveToken: async () => oauthToken, fetchImpl }
    )
    if ('ok' in result) throw new Error(`expected a summary, got ${result.error}`)
    expect(requests).toHaveLength(1)
    expect(requests[0].advertiser_id).toBe(7399999)
  })

  it('falls back to one token-scoped query when the grant list is empty', async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return reportResponse([row()])
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    await buildTikTokReadingSummary(
      {},
      {
        resolveToken: async () => ({ token: 'pasted-token', source: 'pasted', advertiserIds: [] }),
        fetchImpl
      }
    )
    expect(requests).toHaveLength(1)
    expect('advertiser_id' in requests[0]).toBe(false)
  })

  it('surfaces TikTok API failures as ok:false without throwing', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ code: 40100, message: 'Invalid access token', data: {} })) as unknown as (
      url: string,
      init?: RequestInit
    ) => Promise<Response>
    const result = await buildTikTokReadingSummary(
      {},
      { resolveToken: async () => oauthToken, fetchImpl }
    )
    if (!('ok' in result)) throw new Error('expected an error result')
    expect(result.error).toContain('40100')
  })
})
