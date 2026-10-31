import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// buildTikTokReadingSummary pulls the client + resolver chains, which import
// electron-backed stores at module level — stub like the sibling suites.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-unused' } }))

import { isTikTokTodayFailure, previousEqualWindow } from '../../../shared/todayReading'
import { DATASET_LIMITS } from '../../../shared/datasets'
import type { TikTokReportRow } from './tiktokClient'
import {
  buildTikTokReadingSummary,
  buildTikTokTodayReading,
  listTikTokMcpReadingAdvertisers,
  resetTikTokAdvertiserInfoCacheForTest,
  summarizeTikTokReportRows,
  TODAY_ADVERTISER_CAP
} from './tiktokReading'
import type { ResolvedTikTokToken } from './resolveTikTokToken'
import { mergeReportRowsIntoDataset } from './tiktokReportDataset'
import { listDatasets } from '../../boardDatasets'

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
      list: rows.map((row) => ({
        dimensions: { campaign_id: String(1800 + Math.max(0, rows.findIndex((other) => other.campaignName === row.campaignName))), stat_time_day: `${row.date} 00:00:00` },
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
  timezone?: string
}

/**
 * Routes the two GET endpoints the reading uses. `report` answers per
 * advertiser id; `advertisers` is what /advertiser/info/ knows.
 */
function tiktokApi(options: {
  report: (advertiserId: string, params: URLSearchParams) => Response
  advertisers?: Record<string, Advertiser>
  infoFails?: boolean
  infoErrorCode?: (ids: string[], index: number) => number | null
  extraInfo?: Array<{ advertiser_id: string; name: string }>
  granted?: string[]
  defaultTimezone?: boolean
}) {
  const reports: URLSearchParams[] = []
  const infoCalls: string[][] = []
  const methods: Array<string | undefined> = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    methods.push(init?.method)
    if (url !== 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer') throw new Error('non-MCP request')
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } }
    const response = (result: unknown) => jsonResponse({ jsonrpc: '2.0', id: request.id, result })
    if (request.method === 'initialize') return response({ protocolVersion: '2025-03-26' })
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (request.method === 'tools/list') return response({ tools: ['auth_advertiser_get', 'advertiser_info_get', 'report_integrated_get'].map((name) => ({ name })) })
    const args = request.params.arguments ?? {}
    if (request.params.name === 'auth_advertiser_get') return response({ structuredContent: { code: 0, data: { list: (options.granted ?? []).map((advertiser_id) => ({ advertiser_id })) } } })
    if (request.params.name === 'advertiser_info_get') {
      const ids = args.advertiser_ids as string[]
      infoCalls.push(ids)
      const known = options.advertisers ?? {}
      const errorCode = options.infoErrorCode?.(ids, infoCalls.length - 1) ?? (options.infoFails ? 50000 : null)
      const body = errorCode ? { code: errorCode } : { code: 0, data: { list: [...ids.filter((id) => known[id] || options.defaultTimezone).map((id) => ({ advertiser_id: id, name: known[id]?.name ?? '', currency: known[id]?.currency ?? '', timezone: known[id]?.timezone ?? (options.defaultTimezone ? 'UTC' : '') })), ...(options.extraInfo ?? [])] } }
      return response({ structuredContent: body })
    }
    if (request.params.name !== 'report_integrated_get') throw new Error('unexpected tool')
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(args)) params.set(key, String(value))
    reports.push(params)
    const body = await options.report(String(args.advertiser_id ?? ''), params).json() as { data?: { list?: Array<{ dimensions: { stat_time_day: string } }> } }
    // Fixtures without a window-specific day use the beginning of the queried window.
    for (const item of body.data?.list ?? []) {
      if (item.dimensions.stat_time_day.startsWith('2026-01-02')) item.dimensions.stat_time_day = `${args.start_date} 00:00:00`
    }
    if (body.data?.list) body.data.list = body.data.list.filter((item) => item.dimensions.stat_time_day.slice(0, 10) >= String(args.start_date) && item.dimensions.stat_time_day.slice(0, 10) <= String(args.end_date))
    return response({ structuredContent: body })
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

  it('keeps same-named campaigns distinct by account and campaign IDs', () => {
    const { topCampaigns } = summarizeTikTokReportRows([
      row({ advertiserId: ID_A, campaignId: '100', campaignName: 'Same', spend: 10 }),
      row({ advertiserId: ID_B, campaignId: '100', campaignName: 'Same', spend: 30 }),
      row({ advertiserId: ID_A, campaignId: '101', campaignName: 'Same', spend: 20 })
    ])
    expect(topCampaigns).toHaveLength(3)
    expect(topCampaigns.map((campaign) => campaign.spend)).toEqual([30, 20, 10])
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

describe('listTikTokMcpReadingAdvertisers', () => {
  it('discovers the current grant via MCP rather than returning pasted credentials', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), granted: [ID_A, ID_B] })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual([ID_A, ID_B])
    const rejected = tiktokApi({ report: () => reportResponse([]), granted: [ID_A] })
    expect((await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A], 'pasted'), fetchImpl: rejected.fetchImpl })).granted).toEqual([])
    expect(rejected.methods).toHaveLength(0)
  })
  it('loads names in bounded batches while preserving exact authorized IDs', async () => {
    const ids = Array.from({ length: 41 }, (_, index) => String(7300000000 + index))
    const advertisers = Object.fromEntries(ids.map((id, index) => [id, { name: `Synthetic ${index}` }]))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids, advertisers })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual(ids)
    expect(result.accounts).toEqual(ids.map((advertiserId, index) => ({ advertiserId, name: `Synthetic ${index}` })))
    expect(result.namesIncomplete).toBe(false)
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 20, 1])
    expect(api.reports).toHaveLength(0)
  })
  it('keeps every authorized ID at the 500-account ceiling', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => String(7300000000 + index))
    const advertisers = Object.fromEntries(ids.map((id, index) => [id, { name: `Synthetic ${index}` }]))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids, advertisers })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual(ids)
    expect(result.accounts).toHaveLength(500)
    expect(result.accounts?.at(-1)).toEqual({ advertiserId: ids[499], name: 'Synthetic 499' })
    expect(api.infoCalls).toHaveLength(25)
    expect(api.infoCalls.every(batch => batch.length <= 20)).toBe(true)
  })
  it('keeps all IDs and marks names unavailable for failed metadata batches', async () => {
    const ids = Array.from({ length: 41 }, (_, index) => String(7300000000 + index))
    const advertisers = Object.fromEntries(ids.map((id, index) => [id, { name: `Synthetic ${index}` }]))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids, advertisers, infoErrorCode: (_batch, index) => index === 1 ? 50000 : null })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual(ids)
    expect(result.namesIncomplete).toBe(true)
    expect(result.accounts?.slice(20, 40)).toEqual(ids.slice(20, 40).map(advertiserId => ({ advertiserId, name: null })))
    expect(result.accounts?.at(-1)).toEqual({ advertiserId: ids[40], name: 'Synthetic 40' })
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 20, 1])
  })
  it('stops metadata calls after rate limiting while retaining earlier names and every ID', async () => {
    const ids = Array.from({ length: 41 }, (_, index) => String(7300000000 + index))
    const advertisers = Object.fromEntries(ids.map((id, index) => [id, { name: `Synthetic ${index}` }]))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids, advertisers, infoErrorCode: (_batch, index) => index === 1 ? 40131 : null })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual(ids)
    expect(result.namesIncomplete).toBe(true)
    expect(result.accounts?.[0].name).toBe('Synthetic 0')
    expect(result.accounts?.slice(20).every(account => account.name === null)).toBe(true)
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 20])
  })
  it('never chooses an arbitrary name when metadata conflicts for the same ID', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), granted: [ID_A], advertisers: { [ID_A]: { name: 'Synthetic A' } }, extraInfo: [{ advertiser_id: ID_A, name: 'Synthetic B' }] })
    const result = await listTikTokMcpReadingAdvertisers({ resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result.granted).toEqual([ID_A])
    expect(result.accounts).toEqual([{ advertiserId: ID_A, name: null }])
    expect(result.namesIncomplete).toBe(true)
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

  it('rejects a pasted API token before any request', async () => {
    const api = tiktokApi({ report: () => reportResponse([]) })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([], 'pasted'), fetchImpl: api.fetchImpl })
    expect(result).toEqual({ ok: false, error: 'no-credentials' })
    expect(api.methods).toHaveLength(0)
  })

  it('reads each advertiser through MCP for complete days ending yesterday', async () => {
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

    expect(api.methods.every((method) => method === 'POST')).toBe(true)
    expect(api.reports.map((params) => params.get('advertiser_id'))).toEqual([ID_A, ID_B])
    expect(api.reports.every((params) => params.get('start_date') === '2026-09-13')).toBe(true)
    expect(api.reports.every((params) => params.get('end_date') === '2026-09-19')).toBe(true)
  })

  it("range '1' requests the account's verified current day", async () => {
    const api = tiktokApi({
      advertisers: { [ID_A]: { timezone: 'Asia/Shanghai', currency: 'USD' } },
      report: () =>
        reportResponse([
          row({ date: '2026-09-19', campaignName: '昨日', spend: 90 }),
          row({ date: '2026-09-20', campaignName: '今日进行中', spend: 30 })
        ])
    })
    const result = await buildTikTokReadingSummary(
      { range: '1' },
      { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 }
    )
    if ('ok' in result) throw new Error(`expected a summary, got ${result.error}`)
    // Only the verified account-local current day is requested.
    expect(result.totals.spend).toBe(30)
    expect(result.startDate).toBe('2026-09-20')
    expect(result.endDate).toBe('2026-09-20')
    expect(result.topCampaigns.map((campaign) => campaign.name)).toEqual(['今日进行中'])
  })

  it('reads each account today in its own verified timezone, including different local dates', async () => {
    const api = tiktokApi({
      advertisers: { [ID_A]: { timezone: 'Asia/Tokyo', currency: 'USD' }, [ID_B]: { timezone: 'America/Los_Angeles', currency: 'USD' } },
      report: (id, params) => reportResponse([row({ date: params.get('start_date')!, campaignName: id === ID_A ? 'A' : 'B', spend: id === ID_A ? 10 : 20 })])
    })
    const saved: unknown[] = []
    const result = await buildTikTokReadingSummary({ range: '1' }, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-09-20T00:30:00Z'), persistRows: (_rows, _details, scopes) => { saved.push(scopes) } })
    if ('ok' in result) throw new Error(result.error)
    expect(result.totals.spend).toBe(30)
    expect(result.accountWindows?.map((w) => [w.advertiserId, w.startDate])).toEqual([[ID_A, '2026-09-20'], [ID_B, '2026-09-19']])
    expect(api.reports.map((p) => [p.get('start_date'), p.get('end_date')])).toEqual([['2026-09-20', '2026-09-20'], ['2026-09-19', '2026-09-19']])
    expect(saved).toHaveLength(1)
  })

  it('excludes and reports unknown-timezone accounts instead of assigning another account day', async () => {
    const api = tiktokApi({ advertisers: { [ID_A]: { timezone: 'UTC' }, [ID_B]: {} }, report: (_id, params) => reportResponse([row({ date: params.get('start_date')!, spend: 10 })]) })
    const result = await buildTikTokReadingSummary({ range: '1' }, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-09-20T12:00:00Z'), persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(result.advertisers.map((a) => a.advertiserId)).toEqual([ID_A])
    expect(result.failed).toMatchObject([{ advertiserId: ID_B, error: 'api', detail: 'account-timezone-unavailable' }])
    expect(api.reports).toHaveLength(1)
  })

  it('reports dataset write failure while retaining a valid independent reading', async () => {
    const api = tiktokApi({ report: () => reportResponse([row()]), advertisers: { [ID_A]: { currency: 'USD' } } })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, persistRows: () => ({ ok: false, error: 'row-limit' }) })
    if ('ok' in result) throw new Error(result.error)
    expect(result.totals.spend).toBe(10)
    expect(result.datasetSync).toEqual({ ok: false, error: 'row-limit' })
  })
  it('attaches proofs only for successfully persisted account windows', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: { [ID_A]: { currency: 'USD' } } })
    const dataset = { id: 'test-dataset', name: 'TikTok 报表', createdAt: 0, columns: [{ name: '日期', type: 'date' as const }, { name: '广告主ID', type: 'text' as const }], rows: [] }
    const onDatasetCommitted = vi.fn()
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, onDatasetCommitted, persistRows: (_rows, _details, _scopes, beforeCommit) => { beforeCommit?.(dataset); return { ok: true, dataset, truncated: false } } })
    if ('ok' in result) throw new Error(result.error)
    expect(result.datasetSync).toMatchObject({ ok: true, proofs: [{ advertiserId: ID_A, digest: expect.stringMatching(/^[0-9a-f]{64}$/) }] })
    const bad = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, onDatasetCommitted, persistRows: (_rows, _details, _scopes, beforeCommit) => { beforeCommit?.({ ...dataset, columns: [] }); return { ok: true, dataset, truncated: false } } })
    if ('ok' in bad) throw new Error(bad.error)
    expect(bad.datasetSync).toEqual({ ok: false, error: 'proof-failed' })
    expect(onDatasetCommitted).toHaveBeenCalledOnce()
  })
  it('does not write or broadcast when pre-commit SHA-256 fails', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tt-proof-failure-'))
    const file = path.join(dir, 'dataset.json')
    try {
      const originalRow = row({ advertiserId: ID_A, campaignId: '100', date: '2026-09-15', spend: 10 })
      const scope = [{ advertiserId: ID_A, startDate: '2026-09-13', endDate: '2026-09-19' }]
      expect(mergeReportRowsIntoDataset([originalRow], undefined, file, scope).ok).toBe(true)
      const before = readFileSync(file, 'utf8')
      const api = tiktokApi({ report: () => reportResponse([row({ date: '2026-09-15', spend: 99 })]), advertisers: { [ID_A]: { currency: 'USD' } } })
      const onDatasetCommitted = vi.fn()
      const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20, onDatasetCommitted, hashProofPayload: () => { throw new Error('simulated crypto failure') }, persistRows: (rows, details, scopes, beforeCommit) => mergeReportRowsIntoDataset(rows, details, file, scopes, undefined, beforeCommit) })
      if ('ok' in result) throw new Error(result.error)
      expect(result.datasetSync).toEqual({ ok: false, error: 'proof-failed' })
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(onDatasetCommitted).not.toHaveBeenCalled()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('discovers all 51 granted accounts despite an old 50-account OAuth envelope', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => String(7300000000 + index))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids })
    const result = await buildTikTokReadingSummary({}, { resolveToken: async () => ({ token: 'oauth-token', source: 'oauth', advertiserIds: ids.slice(0, 50), selectionExplicit: false }), fetchImpl: api.fetchImpl, persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(result.transport).toBe('mcp')
    expect(result.truncated).toBe(false)
    expect(api.reports).toHaveLength(51)
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 20, 11])
    expect(result.advertisers.map(account => account.advertiserId)).toEqual(ids)
    expect(result.failed).toEqual([])
  })
  it('reads 50 selected accounts in 20/20/10 batches without broadening the scope', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => String(7300000000 + index))
    const api = tiktokApi({ granted: [...ids, '9999999999'], report: () => reportResponse([]) })
    const result = await buildTikTokReadingSummary({}, { resolveToken: async () => ({ token: 'fake', source: 'oauth', advertiserIds: ids, selectionExplicit: true }), fetchImpl: api.fetchImpl, persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 20, 10])
    expect(api.reports.map(report => report.get('advertiser_id'))).toEqual(ids)
    expect(result.advertisers.map(account => account.advertiserId)).toEqual(ids)
    expect(result.failed).toEqual([])
  })
  it('rejects over 500 accounts without silently reading a prefix', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => String(7300000000 + index))
    const api = tiktokApi({ report: () => reportResponse([]), granted: ids })
    const result = await buildTikTokReadingSummary({}, { resolveToken: async () => ({ token: 'fake', source: 'oauth', advertiserIds: [], selectionExplicit: false }), fetchImpl: api.fetchImpl })
    expect(result).toMatchObject({ ok: false, error: 'api', detail: 'account-safety-limit-exceeded' })
    expect(api.reports).toHaveLength(0)
    expect(api.infoCalls).toHaveLength(0)
  })

  it('keeps completed accounts and marks unattempted accounts after rate limiting', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => String(7300000000 + index))
    const advertisers = Object.fromEntries(ids.map(id => [id, { currency: 'USD' }]))
    const api = tiktokApi({ advertisers, report: id => id === ids[20] ? apiError(40131, 'rate limit') : reportResponse([]) })
    let persistedIds: string[] = []
    const progress: Array<{ completed: number; total: number; succeeded: number }> = []
    const result = await buildTikTokReadingSummary({}, { resolveToken: token(ids), fetchImpl: api.fetchImpl, onProgress: value => progress.push(value), persistRows: (_rows, _details, scopes) => { persistedIds = scopes.map(scope => scope.advertiserId) } })
    if ('ok' in result) throw new Error(result.error)
    expect(result.advertisers.map(account => account.advertiserId)).toEqual(ids.slice(0, 20))
    expect(result.failed).toHaveLength(5)
    expect(result.failed[0]).toMatchObject({ advertiserId: ids[20], error: 'rate-limit' })
    expect(result.failed.slice(1).map(account => [account.advertiserId, account.detail])).toEqual(ids.slice(21).map(id => [id, 'account-batch-not-attempted']))
    expect(api.reports).toHaveLength(21)
    expect(persistedIds).toEqual(ids.slice(0, 20))
    expect(progress.at(-1)).toEqual({ completed: 21, total: 25, succeeded: 20 })
  })

  it.each(['summary', 'today'] as const)('cancels %s without touching remaining accounts or persisting partial scope', async (kind) => {
    const ids = Array.from({ length: 21 }, (_, index) => String(7300000000 + index))
    const controller = new AbortController()
    const api = tiktokApi({ defaultTimezone: true, report: id => { if (id === ids[2]) controller.abort(); return reportResponse([]) } })
    const progress: Array<{ completed: number; total: number; succeeded: number }> = []
    const persistRows = vi.fn()
    const onDatasetCommitted = vi.fn()
    const deps = { resolveToken: token(ids), fetchImpl: api.fetchImpl, signal: controller.signal, onProgress: (value: { completed: number; total: number; succeeded: number }) => progress.push(value), persistRows, onDatasetCommitted }
    const result = kind === 'summary' ? await buildTikTokReadingSummary({}, deps) : await buildTikTokTodayReading({}, deps)
    if (kind === 'summary') expect(result).toEqual({ ok: false, error: 'api', detail: 'reading-cancelled' })
    else {
      if ('ok' in result) throw new Error(result.error)
      if (!('accounts' in result)) throw new Error('expected today result')
      expect(result.cancelled).toBe(true)
      expect(result.accounts.slice(0, 2).map(account => isTikTokTodayFailure(account))).toEqual([false, false])
      expect(result.accounts.slice(2).every(account => isTikTokTodayFailure(account) && account.detail === 'account-batch-not-attempted')).toBe(true)
      expect(result.datasetSync).toEqual({ ok: false, error: 'reading-cancelled' })
    }
    expect(api.reports).toHaveLength(3)
    expect(persistRows).not.toHaveBeenCalled()
    expect(onDatasetCommitted).not.toHaveBeenCalled()
    expect(progress.map(({ completed, total, succeeded }) => ({ completed, total, succeeded }))).toEqual([{ completed: 0, total: 21, succeeded: 0 }, { completed: 1, total: 21, succeeded: 1 }, { completed: 2, total: 21, succeeded: 2 }])
  })
  it.each(['summary', 'today'] as const)('continues %s account reads after the dataset buffer limit without writing a partial table', async (kind) => {
    const limits = DATASET_LIMITS as unknown as { maxRows: number }
    const oldLimit = limits.maxRows
    limits.maxRows = 1
    try {
      const ids = [ID_A, ID_B, '7300000000000000003']
      const advertisers = Object.fromEntries(ids.map(id => [id, { currency: 'USD' }]))
      const api = tiktokApi({ advertisers, defaultTimezone: true, report: () => reportResponse([row({ spend: 10 })]) })
      const persistRows = vi.fn()
      const deps = { resolveToken: token(ids), fetchImpl: api.fetchImpl, persistRows }
      if (kind === 'summary') {
        const result = await buildTikTokReadingSummary({}, deps)
        if ('ok' in result) throw new Error(result.error)
        expect(result.advertisers).toHaveLength(3)
        expect(result.totals.spend).toBe(30)
        expect(result.datasetSync).toEqual({ ok: false, error: 'row-limit' })
      } else {
        const result = await buildTikTokTodayReading({}, deps)
        if ('ok' in result) throw new Error(result.error)
        expect(result.accounts).toHaveLength(3)
        expect(result.datasetSync).toEqual({ ok: false, error: 'row-limit' })
      }
      expect(api.reports).toHaveLength(3)
      expect(persistRows).not.toHaveBeenCalled()
    } finally { limits.maxRows = oldLimit }
  })

  it('reads only today for the 1-day range', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: { [ID_A]: { timezone: 'Asia/Shanghai' } } })
    const result = await buildTikTokReadingSummary(
      { range: '1' },
      { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 }
    )
    if ('ok' in result) throw new Error(result.error)
    expect([result.startDate, result.endDate]).toEqual(['2026-09-20', '2026-09-20'])
  })

  it('lets the widget config override the advertiser scope', async () => {
    const api = tiktokApi({ report: () => reportResponse([row()]), advertisers: { '7399999999999999999': { timezone: 'UTC' } } })
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
    expect(result).toMatchObject({ advertisers: [], failed: [{ advertiserId: ID_A, error: 'auth' }, { advertiserId: ID_B, error: 'auth', detail: 'account-batch-not-attempted' }], datasetSync: { ok: false, error: 'no-successful-accounts' } })
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
    if ('ok' in result) throw new Error(result.error)
    expect(result.failed).toMatchObject([{ advertiserId: ID_A, error: 'permission' }, { advertiserId: ID_B, error: 'permission' }])
    expect(result.failed[0].detail).toContain('40001')
    expect(result.datasetSync).toEqual({ ok: false, error: 'no-successful-accounts' })
    expect(api.reports).toHaveLength(2)
  })

  it('does not name a currency when accounts disagree or one is unknown', async () => {
    const mixed = tiktokApi({
      report: () => reportResponse([row()]),
      advertisers: { [ID_A]: { currency: 'USD' }, [ID_B]: { currency: 'EUR' } }
    })
    const mixedResult = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: mixed.fetchImpl })
    if ('ok' in mixedResult) throw new Error(mixedResult.error)
    expect(mixedResult.totals).toMatchObject({ spend: null, costPerConversion: null })
    expect(mixedResult.topCampaigns).toEqual([])
    expect(mixedResult.currency).toBeNull()
    expect(mixedResult.mixedCurrency).toBe(true)

    resetTikTokAdvertiserInfoCacheForTest()
    const partial = tiktokApi({ report: () => reportResponse([row()]), advertisers: { [ID_A]: { currency: 'USD' } } })
    const partialResult = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: partial.fetchImpl })
    if ('ok' in partialResult) throw new Error(partialResult.error)
    expect(partialResult.totals).toMatchObject({ spend: null, costPerConversion: null })
    expect(partialResult.topCampaigns).toEqual([])
    expect(partialResult.currency).toBeNull()
    expect(partialResult.mixedCurrency).toBe(false)
  })

  it('still reads when advertiser names cannot be looked up', async () => {
    const api = tiktokApi({ report: () => reportResponse([row({ spend: 3 })]), infoFails: true })
    const result = await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(result.totals.spend).toBeNull()
    expect(result.advertisers).toEqual([{ advertiserId: ID_A, name: null, currency: null }])
  })

  it('refreshes advertiser information between reads', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: { [ID_A]: { name: 'Main', currency: 'USD' } } })
    await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 })
    await buildTikTokReadingSummary({}, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20 })
    expect(api.infoCalls).toEqual([[ID_A], [ID_A]])
  })
})

describe('buildTikTokTodayReading', () => {
  it.each(['last7', 'last28'] as const)('uses each account timezone for complete-day %s windows', async (range) => {
    const api = tiktokApi({ advertisers: { [ID_A]: { timezone: 'Asia/Tokyo' }, [ID_B]: { timezone: 'America/Los_Angeles' } }, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range }, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z'), persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    const days = range === 'last7' ? 7 : 28
    const ends = result.accounts.map(account => isTikTokTodayFailure(account) ? null : account.window?.end)
    expect(ends).toEqual(['2026-10-31', '2026-10-30'])
    for (const account of result.accounts) {
      if (isTikTokTodayFailure(account)) throw new Error(account.error)
      const current = account.window!, previous = account.previousWindow!
      expect((Date.parse(current.end) - Date.parse(current.start)) / 86_400_000 + 1).toBe(days)
      expect(previous).toEqual(previousEqualWindow(current))
    }
  })

  it('reads a custom range and the equally long prior range without changing the selected account', async () => {
    const api = tiktokApi({ granted: [ID_A, ID_B], advertisers: { [ID_B]: { timezone: 'America/Los_Angeles' } }, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range: 'custom', startDate: '2024-03-09', endDate: '2024-03-12', advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z'), persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(result.range).toBe('custom')
    expect(result.window).toEqual({ start: '2024-03-09', end: '2024-03-12' })
    expect(result.previousWindow).toEqual({ start: '2024-03-05', end: '2024-03-08' })
    expect(api.reports.map(p => [p.get('advertiser_id'), p.get('start_date'), p.get('end_date')])).toEqual([[ID_B, '2024-03-05', '2024-03-12']])
    expect(result.accounts).toMatchObject([{ advertiserId: ID_B, window: result.window, previousWindow: result.previousWindow }])
  })

  it('supports a 366-day custom window without silently shortening it', async () => {
    const api = tiktokApi({ granted: [ID_A], defaultTimezone: true, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range: 'custom', startDate: '2024-01-01', endDate: '2024-12-31', advertiserId: ID_A }, { resolveToken: token([]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z'), persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(result.previousWindow).toEqual({ start: '2022-12-31', end: '2023-12-31' })
    expect(api.reports).toHaveLength(25)
    expect(api.reports[0].get('start_date')).toBe('2022-12-31')
    expect(api.reports.at(-1)?.get('end_date')).toBe('2024-12-31')
  })

  it('validates range and calendar dates before credentials or report requests', async () => {
    const resolveToken = vi.fn(token([ID_A]))
    for (const input of [
      { range: '' }, { range: 'last7trailing' }, { range: 'custom' },
      { range: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' },
      { range: 'custom', startDate: '2026-03-02', endDate: '2026-03-01' },
      { range: 'custom', startDate: '2024-01-01', endDate: '2025-01-01' }
    ]) expect(await buildTikTokTodayReading(input, { resolveToken })).toMatchObject({ ok: false, error: 'invalid-input' })
    expect(resolveToken).not.toHaveBeenCalled()
  })

  it('rejects future custom end dates per account without reading that account', async () => {
    const api = tiktokApi({ advertisers: { [ID_A]: { timezone: 'Asia/Tokyo' }, [ID_B]: { timezone: 'America/Los_Angeles' } }, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range: 'custom', startDate: '2026-11-01', endDate: '2026-11-01' }, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z'), persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports.map(item => item.get('advertiser_id'))).toEqual([ID_A])
    expect(result.accounts[1]).toMatchObject({ advertiserId: ID_B, error: 'invalid-input', detail: 'custom-window-future' })
  })

  it('reads only the requested authorized account without changing the connection selection', async () => {
    const now = Date.parse('2026-11-01T06:30:00Z')
    const api = tiktokApi({ granted: [ID_A, ID_B], advertisers: { [ID_A]: { timezone: 'UTC', currency: 'USD' }, [ID_B]: { timezone: 'America/Los_Angeles', currency: 'USD' } }, report: () => reportResponse([]) })
    const progress: Array<{ completed: number; total: number; succeeded: number }> = []
    let writtenIds: string[] = []
    const result = await buildTikTokTodayReading({ range: 'today', advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: () => now, onProgress: value => progress.push(value), persistRows: (_rows, _details, scopes) => { writtenIds = scopes.map(scope => scope.advertiserId) } })
    if ('ok' in result) throw new Error(result.error)
    expect(result.window).toEqual({ start: '2026-10-31', end: '2026-10-31' })
    expect(result.previousWindow).toEqual({ start: '2026-10-30', end: '2026-10-30' })
    expect(result.accounts).toMatchObject([{ advertiserId: ID_B, window: result.window, previousWindow: result.previousWindow }])
    expect(api.infoCalls).toEqual([[ID_B]])
    expect(api.reports.map(item => [item.get('advertiser_id'), item.get('start_date'), item.get('end_date')])).toEqual([[ID_B, '2026-10-30', '2026-10-31']])
    expect(writtenIds).toEqual([ID_B])
    expect(progress).toMatchObject([{ completed: 0, total: 1, succeeded: 0 }, { completed: 1, total: 1, succeeded: 1, today: { account: { advertiserId: ID_B } } }])
  })

  it('ends the last-seven-days window at the account-local yesterday', async () => {
    const now = Date.parse('2026-11-01T06:30:00Z')
    const api = tiktokApi({ granted: [ID_B], advertisers: { [ID_B]: { timezone: 'America/Los_Angeles', currency: 'USD' } }, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range: 'last7', advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: () => now, persistRows: () => undefined })
    if ('ok' in result) throw new Error(result.error)
    const window = { start: '2026-10-24', end: '2026-10-30' }
    expect(result.window).toEqual(window)
    expect(result.previousWindow).toEqual(previousEqualWindow(window))
    expect(result.accounts).toMatchObject([{ advertiserId: ID_B, window, previousWindow: result.previousWindow }])
  })

  it('updates only the requested account window and preserves other accounts on disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tt-single-account-'))
    const file = path.join(dir, 'dataset.json')
    try {
      const windows = [ID_A, ID_B].map(advertiserId => ({ advertiserId, startDate: '2026-09-06', endDate: '2026-09-19' }))
      const existing = [ID_A, ID_B].map(advertiserId => row({ advertiserId, campaignId: '100', date: '2026-09-15', spend: 10 }))
      expect(mergeReportRowsIntoDataset(existing, undefined, file, windows).ok).toBe(true)
      const api = tiktokApi({ granted: [ID_A, ID_B], advertisers: { [ID_B]: { currency: 'USD', timezone: 'UTC' } }, report: () => reportResponse([row({ date: '2026-09-15', spend: 99 })]) })
      const result = await buildTikTokTodayReading({ range: 'last7', advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: SEP_20, persistRows: (rows, details, scopes) => mergeReportRowsIntoDataset(rows, details, file, scopes) })
      if ('ok' in result) throw new Error(result.error)
      expect(result.datasetSync?.ok).toBe(true)
      const rows = listDatasets(file)[0].rows
      expect(rows.filter(item => item[11] === ID_A).map(item => item[3])).toEqual([10])
      expect(rows.filter(item => item[11] === ID_B).map(item => item[3])).toEqual([99])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails the selected today account when its timezone is unknown', async () => {
    const api = tiktokApi({ granted: [ID_B], advertisers: { [ID_B]: { currency: 'USD' } }, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ range: 'today', advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(result.accounts).toMatchObject([{ advertiserId: ID_B, error: 'api', detail: 'account-timezone-unavailable' }])
    expect(api.reports).toHaveLength(0)
  })

  it('rejects malformed or unauthorized single IDs without reading other accounts', async () => {
    for (const advertiserId of ['', ' 7300001', '7300001\n', '0', 42, null, '9'.repeat(26)]) {
      const resolveToken = vi.fn(token([ID_A]))
      expect(await buildTikTokTodayReading({ advertiserId }, { resolveToken })).toMatchObject({ ok: false, error: 'invalid-input', detail: 'invalid-advertiser-id' })
      expect(resolveToken).not.toHaveBeenCalled()
    }
    const api = tiktokApi({ granted: [ID_A], report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({ advertiserId: ID_B }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl })
    expect(result).toEqual({ ok: false, error: 'permission', detail: 'advertiser-not-authorized' })
    expect(api.infoCalls).toHaveLength(0)
    expect(api.reports).toHaveLength(0)
  })

  it('cancels a single-account read before writing any data', async () => {
    const controller = new AbortController()
    const persistRows = vi.fn()
    const api = tiktokApi({ granted: [ID_A], defaultTimezone: true, report: () => { controller.abort(); return reportResponse([]) } })
    const result = await buildTikTokTodayReading({ advertiserId: ID_A }, { resolveToken: token([ID_B]), fetchImpl: api.fetchImpl, signal: controller.signal, persistRows })
    expect(result).toMatchObject({ cancelled: true, accounts: [{ advertiserId: ID_A, error: 'api', detail: 'account-batch-not-attempted' }], datasetSync: { ok: false, error: 'reading-cancelled' } })
    expect(persistRows).not.toHaveBeenCalled()
    expect(api.reports).toHaveLength(1)
  })
  it('saves complete successful account windows and reports dataset failures independently', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: { [ID_A]: { timezone: 'UTC', currency: 'USD' } } })
    const persistRows: NonNullable<import('./tiktokReading').TikTokReadingDeps['persistRows']> = vi.fn(() => ({ ok: false as const, error: 'write-failed' as const }))
    const result = await buildTikTokTodayReading({ range: 'today' }, { resolveToken: token([ID_A]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z'), persistRows })
    if ('ok' in result) throw new Error(result.error)
    expect(result.datasetSync).toEqual({ ok: false, error: 'write-failed' })
    expect(vi.mocked(persistRows).mock.calls[0][2]).toEqual([{ advertiserId: ID_A, startDate: '2026-10-31', endDate: '2026-11-01' }])
    expect(result.accounts).toHaveLength(1)
  })

  it('requests each account today and previous day in its own timezone', async () => {
    const api = tiktokApi({ report: () => reportResponse([]), advertisers: {
      [ID_A]: { name: 'A', currency: 'USD', timezone: 'Asia/Tokyo' },
      [ID_B]: { name: 'B', currency: 'USD', timezone: 'America/Los_Angeles' }
    } })
    const result = await buildTikTokTodayReading({ range: 'today' }, {
      resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: () => Date.parse('2026-11-01T06:30:00Z')
    })
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports.map((request) => [request.get('start_date'), request.get('end_date')])).toEqual([
      ['2026-10-31', '2026-11-01'], ['2026-10-30', '2026-10-31']
    ])
    expect(result.accounts.map((account) => 'window' in account ? account.window : null)).toEqual([
      { start: '2026-11-01', end: '2026-11-01' }, { start: '2026-10-31', end: '2026-10-31' }
    ])
  })

  it('splits one report pull into the current window and the previous one', async () => {
    const api = tiktokApi({
      report: () =>
        reportResponse([
          row({ date: '2026-09-30', campaignName: 'A', spend: 10, impressions: 100, clicks: 5, conversion: 1 }),
          row({ date: '2026-09-20', campaignName: 'A', spend: 4, impressions: 40, clicks: 2, conversion: 0 }),
          row({ date: '2026-09-20', campaignName: 'B', spend: 30, impressions: 10, clicks: 1, conversion: 0 })
        ]),
      advertisers: { [ID_A]: { name: 'Main', currency: 'USD', timezone: 'UTC' } }
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
    expect(api.reports).toHaveLength(0)
  })

  it('keeps a failed advertiser as its own row', async () => {
    const api = tiktokApi({
      defaultTimezone: true, report: (id) => (id === ID_B ? apiError(40001, 'No permission to operate') : reportResponse([row({ date: '2026-09-19' })]))
    })
    const result = await buildTikTokTodayReading({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl, now: SEP_20 })
    if ('ok' in result) throw new Error(result.error)
    expect(result.accounts.map((account) => (isTikTokTodayFailure(account) ? account.error : 'ok'))).toEqual(['ok', 'permission'])
    expect(result.accounts[1].advertiserId).toBe(ID_B)
  })

  it('fails the whole page when the token is rejected', async () => {
    const api = tiktokApi({ defaultTimezone: true, report: () => apiError(40104, 'Access token is empty') })
    const result = await buildTikTokTodayReading({}, { resolveToken: token([ID_A, ID_B]), fetchImpl: api.fetchImpl })
    expect(result).toMatchObject({ accounts: [{ advertiserId: ID_A, error: 'auth' }, { advertiserId: ID_B, error: 'auth', detail: 'account-batch-not-attempted' }], datasetSync: { ok: false, error: 'no-successful-accounts' } })
    expect(api.reports).toHaveLength(1)
  })

  it('reads every advertiser in bounded metadata batches', async () => {
    const ids = Array.from({ length: TODAY_ADVERTISER_CAP + 1 }, (_, index) => String(7300000000 + index))
    const api = tiktokApi({ defaultTimezone: true, report: () => reportResponse([]) })
    const result = await buildTikTokTodayReading({}, { resolveToken: token(ids), fetchImpl: api.fetchImpl })
    if ('ok' in result) throw new Error(result.error)
    expect(api.reports).toHaveLength(ids.length)
    expect(api.infoCalls.map(batch => batch.length)).toEqual([20, 1])
    expect(result.truncated).toBe(false)
    expect(result.accounts).toHaveLength(ids.length)
    expect(result.accounts.at(-1)).toMatchObject({ advertiserId: ids.at(-1) })
  })
})
