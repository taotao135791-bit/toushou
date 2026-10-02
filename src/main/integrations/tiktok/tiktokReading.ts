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
  topSpendMoves,
  type TikTokTodayAccount,
  type TikTokTodayReadingResult
} from '../../../shared/todayReading'
import { resolveTikTokToken } from './resolveTikTokToken'
import {
  classifyTikTokError,
  fetchAdvertiserInfo,
  fetchIntegratedReport,
  type TikTokApiFetch,
  type TikTokReportRow
} from './tiktokClient'

/**
 * TT 读数 board module (tt-reading widget) — Main-side data path. Unlike FB
 * 读数 (its own browser-pipeline), this reads TikTok Ads directly through
 * the report Open API using the token resolved by resolveTikTokToken: the
 * official OAuth connector's auto-refreshed token first, the paste-token
 * store as fallback. Everything crossing IPC is bounded and validated here;
 * the aggregation itself is a pure function for tests.
 */

/** Morning page queries at most this many advertisers. */
export const TODAY_ADVERTISER_CAP = 8

/** Upper bound on advertiser fan-out per summary request (mirrors the refresh service). */
export const MAX_ADVERTISERS_PER_SUMMARY = 20

/** These failures hit every advertiser alike, so the read stops at the first one. */
const WHOLE_READ_FAILURES: ReadonlySet<ReadingErrorCode> = new Set(['auth', 'network', 'rate-limit'])

const ADVERTISER_INFO_TTL_MS = 6 * 60 * 60 * 1000
const ADVERTISER_INFO_MISS_TTL_MS = 30 * 60 * 1000

const advertiserInfoCache = new Map<string, { advertiser: TikTokReadingAdvertiser; found: boolean; fetchedAt: number }>()

export function resetTikTokAdvertiserInfoCacheForTest(): void {
  advertiserInfoCache.clear()
}

/**
 * Names and currencies for display. A failed lookup leaves the bare id on
 * screen; the report call is what reports real failures.
 */
async function lookupAdvertisers(
  fetchImpl: TikTokApiFetch,
  accessToken: string,
  advertiserIds: string[],
  now: number
): Promise<Map<string, TikTokReadingAdvertiser>> {
  const stale = advertiserIds.filter((id) => {
    const cached = advertiserInfoCache.get(id)
    if (!cached) return true
    return now - cached.fetchedAt > (cached.found ? ADVERTISER_INFO_TTL_MS : ADVERTISER_INFO_MISS_TTL_MS)
  })
  if (stale.length > 0) {
    let found: TikTokReadingAdvertiser[] = []
    try {
      found = await fetchAdvertiserInfo(fetchImpl, { accessToken, advertiserIds: stale })
    } catch {
      found = []
    }
    for (const id of stale) {
      const advertiser = found.find((info) => info.advertiserId === id)
      advertiserInfoCache.set(id, {
        advertiser: advertiser ?? { advertiserId: id, name: null, currency: null },
        found: Boolean(advertiser),
        fetchedAt: now
      })
    }
  }
  return new Map(
    advertiserIds.map((id) => [id, advertiserInfoCache.get(id)?.advertiser ?? { advertiserId: id, name: null, currency: null }])
  )
}

function campaignSpends(rows: TikTokReportRow[]): Array<{ name: string; spend: number }> {
  const byName = new Map<string, number>()
  for (const row of rows) {
    const name = row.campaignName || '—'
    const spend = typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0
    byName.set(name, (byName.get(name) ?? 0) + spend)
  }
  return [...byName.entries()].map(([name, spend]) => ({ name, spend }))
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
  const resolved = await (deps.resolveToken ?? resolveTikTokToken)()
  if (!resolved.token) return readingFailure('no-credentials')
  if (resolved.advertiserIds.length === 0) return readingFailure('no-advertiser')
  const advertiserIds = resolved.advertiserIds.slice(0, TODAY_ADVERTISER_CAP)
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const advertisers = await lookupAdvertisers(fetchImpl, resolved.token, advertiserIds, now)
  const accounts: TikTokTodayAccount[] = []
  for (const advertiserId of advertiserIds) {
    const advertiser = advertisers.get(advertiserId) ?? { advertiserId, name: null, currency: null }
    let rows: TikTokReportRow[]
    try {
      rows = await fetchIntegratedReport(fetchImpl, {
        accessToken: resolved.token,
        advertiserId,
        startDate: previous.start,
        endDate: window.end
      })
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
      campaigns: topSpendMoves(campaignSpends(currentRows), campaignSpends(previousRows), 3)
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
    truncated: resolved.advertiserIds.length > TODAY_ADVERTISER_CAP,
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
 * grouped by name, summed on spend / impressions / clicks / conversions,
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
  const byCampaign = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number }>()
  const add = (value: number | null): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  for (const row of rows) {
    const name = row.campaignName || '—'
    const current = byCampaign.get(name) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
    current.spend += add(row.spend)
    current.impressions += add(row.impressions)
    current.clicks += add(row.clicks)
    current.conversions += add(row.conversion)
    byCampaign.set(name, current)
  }
  const topCampaigns = [...byCampaign.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))
    .slice(0, 5)
  return { totals, topCampaigns }
}

export interface TikTokReadingDeps {
  /** Token source; defaults to the shared resolver (OAuth first, paste fallback). */
  resolveToken?: () => Promise<Awaited<ReturnType<typeof resolveTikTokToken>>>
  fetchImpl?: TikTokApiFetch
  now?: () => number
}

/**
 * IPC-facing builder for TT 读数: resolve credentials → pull the integrated
 * report per advertiser → aggregate. The widget's own advertiser list wins
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
  const resolved = await (deps.resolveToken ?? resolveTikTokToken)()
  if (!resolved.token) return readingFailure('no-credentials')
  const advertiserIds = (override.length > 0 ? override : resolved.advertiserIds).slice(0, MAX_ADVERTISERS_PER_SUMMARY)
  if (advertiserIds.length === 0) return readingFailure('no-advertiser')
  const { start: startDate, end: endDate } = tiktokReadingRangeWindow(range, new Date(now))
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const info = await lookupAdvertisers(fetchImpl, resolved.token, advertiserIds, now)
  const rows: TikTokReportRow[] = []
  const advertisers: TikTokReadingAdvertiser[] = []
  const failed: TikTokReadingAdvertiserFailure[] = []
  for (const advertiserId of advertiserIds) {
    const advertiser = info.get(advertiserId) ?? { advertiserId, name: null, currency: null }
    try {
      rows.push(...(await fetchIntegratedReport(fetchImpl, { accessToken: resolved.token, advertiserId, startDate, endDate })))
      advertisers.push(advertiser)
    } catch (error) {
      const failure = classifyTikTokError(error)
      if (WHOLE_READ_FAILURES.has(failure.code)) return readingFailure(failure.code, failure.detail)
      failed.push({ ...advertiser, error: failure.code, detail: failure.detail })
    }
  }
  if (advertisers.length === 0 && failed.length > 0) return readingFailure(failed[0].error, failed[0].detail)
  const { totals, topCampaigns } = summarizeTikTokReportRows(rows)
  const known = [...new Set(advertisers.map((advertiser) => advertiser.currency).filter((code): code is string => !!code))]
  const everyKnown = advertisers.every((advertiser) => advertiser.currency !== null)
  const summary: TikTokReadingSummary = {
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
