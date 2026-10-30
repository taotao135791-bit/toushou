import { readingFailure, type ReadingErrorCode } from '../../../shared/readingError'
import {
  isTikTokReadingRange,
  parseTikTokAdvertiserIdList,
  type TikTokReadingAdvertiser,
  type TikTokReadingAdvertiserFailure,
  type TikTokReadingResult,
  type TikTokReadingSummary,
  type TikTokReadingTopCampaign,
  type TikTokReadingTotals
} from '../../../shared/tiktokReport'
import {
  isTikTokTodayFailure,
  isTodayRange,
  previousEqualWindow,
  tiktokReadingRangeWindow,
  todayWindow,
  type TikTokTodayAccount,
  type TikTokTodayReadingResult
} from '../../../shared/todayReading'
import { resolveTikTokMcpToken, type ResolvedTikTokToken } from './resolveTikTokToken'
import { TikTokMcpReadingClient } from './tiktokMcpReadingClient'
import { listTikTokReadingAdvertisers } from './tiktokReadingAdvertisers'
import {
  classifyTikTokError,
  type TikTokApiFetch,
  type TikTokReportRow
} from './tiktokClient'

/**
 * TT 读数 uses only the app-owned official TikTok MCP OAuth connection.
 * Everything crossing IPC is bounded and validated here;
 * the aggregation itself is a pure function for tests.
 */

/** Morning page queries at most this many advertisers. */
export const TODAY_ADVERTISER_CAP = 8

/** Upper bound on advertiser fan-out per summary request (mirrors the refresh service). */
export const MAX_ADVERTISERS_PER_SUMMARY = 20

/** These failures hit every advertiser alike, so the read stops at the first one. */
const WHOLE_READ_FAILURES: ReadonlySet<ReadingErrorCode> = new Set(['auth', 'network', 'rate-limit'])

/** Compatibility hook for existing tests; info is fetched per read to avoid stale account data. */
export function resetTikTokAdvertiserInfoCacheForTest(): void {}

/** Names and currencies are optional; report errors are handled separately. */
async function lookupAdvertisers(
  client: TikTokMcpReadingClient,
  advertiserIds: string[]
): Promise<Map<string, TikTokReadingAdvertiser>> {
  let found: TikTokReadingAdvertiser[] = []
  try { found = await client.info(advertiserIds) } catch { /* keep unknown metadata */ }
  const byId = new Map(found.map((advertiser) => [advertiser.advertiserId, advertiser]))
  return new Map(advertiserIds.map((id) => [id, byId.get(id) ?? { advertiserId: id, name: null, currency: null }]))
}

function campaignSpends(rows: TikTokReportRow[]): Array<{ key: string; name: string; spend: number }> {
  const grouped = new Map<string, { key: string; name: string; spend: number }>()
  for (const row of rows) {
    const name = row.campaignName || '—'
    const key = row.advertiserId && row.campaignId ? `${row.advertiserId}:${row.campaignId}` : name
    const current = grouped.get(key) ?? { key, name, spend: 0 }
    current.spend += typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0
    grouped.set(key, current)
  }
  return [...grouped.values()]
}

function campaignMoves(current: TikTokReportRow[], previous: TikTokReportRow[]) {
  const before = new Map(campaignSpends(previous).map((row) => [row.key, row]))
  const after = new Map(campaignSpends(current).map((row) => [row.key, row]))
  return [...new Set([...after.keys(), ...before.keys()])].map((key) => {
    const spend = after.get(key)?.spend ?? 0
    const previousSpend = before.get(key)?.spend ?? 0
    return { key, name: after.get(key)?.name ?? before.get(key)!.name, spend, previousSpend, delta: spend - previousSpend }
  }).filter((row) => row.spend !== 0 || row.previousSpend !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.spend - a.spend || a.name.localeCompare(b.name)).slice(0, 3)
}

function rowsInWindow(rows: TikTokReportRow[], window: { start: string; end: string }): TikTokReportRow[] {
  return rows.filter((row) => row.date >= window.start && row.date <= window.end)
}

/**
 * Today-page TikTok read. One report pull per advertiser covers the current
 * window and the previous equal window, then the rows are split by date.
 * This does not change the board widget's own 1/7/28 summary.
 */
export async function buildTikTokTodayReading(
  input: { range?: unknown } = {},
  deps: TikTokReadingDeps = {}
): Promise<TikTokTodayReadingResult> {
  const now = deps.now?.() ?? Date.now()
  const range = isTodayRange(input.range) ? input.range : 'last7'
  const window = todayWindow(range, new Date(now))
  const previous = previousEqualWindow(window)
  if (!previous) return readingFailure('invalid-input')
  const prepared = await prepareMcp(deps)
  if ('ok' in prepared) return prepared
  const { resolved, client, allAdvertisers } = prepared
  const advertiserIds = allAdvertisers.slice(0, TODAY_ADVERTISER_CAP)
  const advertisers = await lookupAdvertisers(client, advertiserIds)
  const accounts: TikTokTodayAccount[] = []
  for (const advertiserId of advertiserIds) {
    const advertiser = advertisers.get(advertiserId) ?? { advertiserId, name: null, currency: null }
    let rows: TikTokReportRow[]
    try {
      rows = await client.report(advertiserId, previous.start, window.end)
    } catch (error) {
      const failure = classifyTikTokError(error)
      if (WHOLE_READ_FAILURES.has(failure.code)) return readingFailure(failure.code, failure.detail)
      accounts.push({ ...advertiser, error: failure.code, detail: failure.detail })
      continue
    }
    const currentRows = rowsInWindow(rows, window)
    const previousRows = rowsInWindow(rows, previous)
    const currentTotals = summarizeTikTokReportRows(currentRows).totals
    const previousTotals = summarizeTikTokReportRows(previousRows).totals
    accounts.push({
      ...advertiser,
      spend: currentTotals.spend,
      previousSpend: previousTotals.spend,
      impressions: currentTotals.impressions,
      clicks: currentTotals.clicks,
      conversions: currentTotals.conversions,
      campaigns: campaignMoves(currentRows, previousRows)
    })
  }
  const firstFailure = accounts.find(isTikTokTodayFailure)
  if (firstFailure && accounts.every(isTikTokTodayFailure)) {
    return readingFailure(firstFailure.error, firstFailure.detail)
  }
  return {
    range,
    window,
    previousWindow: previous,
    source: resolved.source,
    generatedAt: now,
    truncated: allAdvertisers.length > TODAY_ADVERTISER_CAP,
    accounts
  }
}

function sumField(rows: TikTokReportRow[], key: 'spend' | 'impressions' | 'clicks' | 'conversion'): number {
  let total = 0
  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/** Outcome of the pure aggregation — the summary's computed halves. */
export interface TikTokReadingAggregate {
  totals: TikTokReadingTotals
  topCampaigns: TikTokReadingTopCampaign[]
}

/**
 * Aggregate report rows into totals + top campaigns. Sums are additive over
 * every row; CTR and cost-per-conversion are RECOMPUTED from the summed
 * denominators (never averaged from per-row ratios); the campaign list is
 * grouped by account and campaign IDs, summed on spend / impressions / clicks / conversions,
 * and cut to the top 5 by spend. Rates stay out of this list so the
 * renderer can recompute them from the summed counts.
 */
export function summarizeTikTokReportRows(rows: TikTokReportRow[]): TikTokReadingAggregate {
  const spend = sumField(rows, 'spend')
  const impressions = sumField(rows, 'impressions')
  const clicks = sumField(rows, 'clicks')
  const conversions = sumField(rows, 'conversion')
  const totals: TikTokReadingTotals = {
    spend,
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    conversions,
    costPerConversion: conversions > 0 ? spend / conversions : 0
  }
  const byCampaign = new Map<string, { name: string; key?: string; spend: number; impressions: number; clicks: number; conversions: number }>()
  const add = (value: number | null): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  for (const row of rows) {
    const name = row.campaignName || '—'
    const key = row.advertiserId && row.campaignId ? `${row.advertiserId}:${row.campaignId}` : name
    const current = byCampaign.get(key) ?? { name, ...(row.advertiserId && row.campaignId ? { key } : {}), spend: 0, impressions: 0, clicks: 0, conversions: 0 }
    current.spend += add(row.spend)
    current.impressions += add(row.impressions)
    current.clicks += add(row.clicks)
    current.conversions += add(row.conversion)
    byCampaign.set(key, current)
  }
  const topCampaigns = [...byCampaign.values()]
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))
    .slice(0, 5)
  return { totals, topCampaigns }
}

export interface TikTokReadingDeps {
  /** App-managed MCP OAuth credentials; pasted API tokens are rejected. */
  resolveToken?: () => Promise<ResolvedTikTokToken>
  fetchImpl?: TikTokApiFetch
  now?: () => number
}

/** Discover authorized accounts through MCP, independent of the user's selection. */
export async function listTikTokMcpReadingAdvertisers(deps: TikTokReadingDeps = {}) {
  const selected = listTikTokReadingAdvertisers()
  const resolved = await (deps.resolveToken ? deps.resolveToken() : resolveTikTokMcpToken({ ignoreSelected: true }))
  if (!resolved.token || resolved.source !== 'oauth') return { selected, granted: [] as string[] }
  const client = new TikTokMcpReadingClient(resolved.token, deps.fetchImpl)
  await client.initialize()
  const granted = await client.advertisers()
  return { selected, granted }
}

/** Only a managed OAuth grant can authenticate the app-owned MCP server. */
async function prepareMcp(deps: TikTokReadingDeps, override: string[] = []) {
  try {
    const resolved = await (deps.resolveToken ?? resolveTikTokMcpToken)()
    if (!resolved.token || resolved.source !== 'oauth') return readingFailure('no-credentials')
    const client = new TikTokMcpReadingClient(resolved.token, deps.fetchImpl)
    await client.initialize()
    const allAdvertisers = override.length ? override : resolved.advertiserIds.length ? resolved.advertiserIds : await client.advertisers()
    if (!allAdvertisers.length) return readingFailure('no-advertiser')
    return { resolved, client, allAdvertisers }
  } catch (error) {
    const failure = classifyTikTokError(error)
    return readingFailure(failure.code, failure.detail)
  }
}

/**
 * IPC-facing builder for TT 读数: discover MCP tools → read reports → aggregate. The widget's own advertiser list wins
 * over the resolved one. Errors surface as stable reading error codes; an
 * advertiser that fails on its own is listed in `failed` while the rest
 * still add up.
 */
export async function buildTikTokReadingSummary(
  input: { advertiserIds?: unknown; range?: unknown } = {},
  deps: TikTokReadingDeps = {}
): Promise<TikTokReadingResult> {
  const now = deps.now?.() ?? Date.now()
  const range = isTikTokReadingRange(input.range) ? input.range : '7'
  const override = input.advertiserIds === undefined ? [] : parseTikTokAdvertiserIdList(input.advertiserIds)
  if (override === null) return readingFailure('invalid-input')
  const prepared = await prepareMcp(deps, override)
  if ('ok' in prepared) return prepared
  const { resolved, client, allAdvertisers } = prepared
  const advertiserIds = allAdvertisers.slice(0, MAX_ADVERTISERS_PER_SUMMARY)
  let { start: startDate, end: endDate } = tiktokReadingRangeWindow(range, new Date(now))
  // "今天" spans yesterday+today in the QUERY: stat days follow the ACCOUNT's
  // timezone, so local-today may not exist yet (e.g. a UTC-6 account at
  // UTC+8 noon). The display then trims to the newest day that HAS data and
  // reports that day honestly in startDate/endDate.
  if (range === '1') {
    const window = tiktokReadingRangeWindow('3', new Date(now))
    startDate = window.start
    endDate = window.end
  }
  const info = await lookupAdvertisers(client, advertiserIds)
  const rows: TikTokReportRow[] = []
  const advertisers: TikTokReadingAdvertiser[] = []
  const failed: TikTokReadingAdvertiserFailure[] = []
  for (const advertiserId of advertiserIds) {
    const advertiser = info.get(advertiserId) ?? { advertiserId, name: null, currency: null }
    try {
      rows.push(...(await client.report(advertiserId, startDate, endDate)))
      advertisers.push(advertiser)
    } catch (error) {
      const failure = classifyTikTokError(error)
      if (WHOLE_READ_FAILURES.has(failure.code)) return readingFailure(failure.code, failure.detail)
      failed.push({ ...advertiser, error: failure.code, detail: failure.detail })
    }
  }
  if (advertisers.length === 0 && failed.length > 0) return readingFailure(failed[0].error, failed[0].detail)
  let shownRows = rows
  if (range === '1') {
    if (rows.length > 0) {
      const newest = rows.reduce((max, row) => (row.date > max ? row.date : max), rows[0].date)
      shownRows = rows.filter((row) => row.date === newest)
      startDate = newest
      endDate = newest
    } else {
      // No data at all: show the requested day, not the wider query window.
      const oneDay = tiktokReadingRangeWindow('1', new Date(now))
      startDate = oneDay.start
      endDate = oneDay.end
    }
  }
  const { totals, topCampaigns } = summarizeTikTokReportRows(shownRows)
  const known = [...new Set(advertisers.map((advertiser) => advertiser.currency).filter((code): code is string => !!code))]
  const everyKnown = advertisers.every((advertiser) => advertiser.currency !== null)
  const summary: TikTokReadingSummary = {
    transport: 'mcp',
    truncated: allAdvertisers.length > MAX_ADVERTISERS_PER_SUMMARY,
    range,
    startDate,
    endDate,
    totals,
    topCampaigns,
    source: resolved.source,
    generatedAt: now,
    advertisers,
    failed,
    currency: known.length === 1 && everyKnown ? known[0] : null,
    mixedCurrency: known.length > 1
  }
  return summary
}
