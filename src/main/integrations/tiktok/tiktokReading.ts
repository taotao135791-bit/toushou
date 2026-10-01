import {
  isTikTokReadingRange,
  type TikTokReadingRange,
  type TikTokReadingResult,
  type TikTokReadingSummary,
  type TikTokReadingTopCampaign,
  type TikTokReadingTotals
} from '../../../shared/tiktokReport'
import {
  isTodayRange,
  previousEqualWindow,
  todayWindow,
  topSpendMoves,
  type TikTokTodayAccount,
  type TikTokTodayReadingResult
} from '../../../shared/todayReading'
import { resolveTikTokToken } from './resolveTikTokToken'
import { fetchIntegratedReport, type TikTokApiFetch, type TikTokReportRow } from './tiktokClient'

/**
 * TT 读数 board module (tt-reading widget) — Main-side data path. Unlike FB
 * 读数 (its own browser-pipeline), this reads TikTok Ads directly through
 * the report Open API using the token resolved by resolveTikTokToken: the
 * official OAuth connector's auto-refreshed token first, the paste-token
 * store as fallback. Everything crossing IPC is bounded and validated here;
 * the aggregation itself is a pure function for tests.
 */

/** Morning page queries at most this many granted advertisers. */
export const TODAY_ADVERTISER_CAP = 8

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
 * Today-page TikTok read. One report pull covers the current window and the
 * previous equal window, then the rows are split by date. This does not
 * change the board widget's own 1/7/28 summary.
 */
export async function buildTikTokTodayReading(
  input: { range?: unknown } = {},
  deps: TikTokReadingDeps = {}
): Promise<TikTokTodayReadingResult> {
  const range = isTodayRange(input.range) ? input.range : 'last7'
  const window = todayWindow(range, new Date(deps.now?.() ?? Date.now()))
  const previous = previousEqualWindow(window)
  if (!previous) return { ok: false, error: 'invalid-input' }
  const resolve = deps.resolveToken ?? resolveTikTokToken
  const resolved = await resolve()
  if (!resolved.token) return { ok: false, error: 'no-credentials' }
  const granted = resolved.advertiserIds
  const capped = granted.slice(0, TODAY_ADVERTISER_CAP)
  const queries: Array<number | undefined> = capped.length > 0 ? capped : [undefined]
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  try {
    const accounts: TikTokTodayAccount[] = []
    for (const advertiserId of queries) {
      const rows = await fetchIntegratedReport(fetchImpl, {
        accessToken: resolved.token,
        startDate: previous.start,
        endDate: window.end,
        ...(advertiserId !== undefined ? { advertiserId } : {})
      })
      const currentRows = rowsInWindow(rows, window)
      const previousRows = rowsInWindow(rows, previous)
      const currentTotals = summarizeTikTokReportRows(currentRows).totals
      const previousTotals = summarizeTikTokReportRows(previousRows).totals
      accounts.push({
        advertiserId: advertiserId ?? null,
        spend: currentTotals.spend,
        previousSpend: previousTotals.spend,
        impressions: currentTotals.impressions,
        clicks: currentTotals.clicks,
        conversions: currentTotals.conversions,
        campaigns: topSpendMoves(campaignSpends(currentRows), campaignSpends(previousRows), 3)
      })
    }
    return {
      range,
      window,
      previousWindow: previous,
      source: resolved.source,
      generatedAt: deps.now?.() ?? Date.now(),
      truncated: granted.length > TODAY_ADVERTISER_CAP,
      accounts
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message.slice(0, 300) }
  }
}

/** Upper bound on advertiser fan-out per summary request (mirrors the refresh service). */
export const MAX_ADVERTISERS_PER_SUMMARY = 20

/** Longest accepted advertiserIds config string ("7300…, 7311…"). */
export const MAX_ADVERTISER_IDS_LENGTH = 400

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

/** Same shape rules as the shared tt-reading widget validator: bounded, digits/separator punctuation only, no control chars. */
export function isValidTikTokReadingAdvertiserIds(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ADVERTISER_IDS_LENGTH &&
    !CONTROL_RE.test(value) &&
    /^[\d,，;；\s]*$/.test(value)
  )
}

/**
 * Parse the widget's comma-separated advertiser list into query ids. Absent,
 * empty or all-blank input returns null (= "ask the token's own grant" — the
 * widget's default config carries ''); malformed segments are skipped,
 * mirroring the TikTok client's tolerance.
 */
export function parseTikTokReadingAdvertiserIds(raw: unknown): number[] | null {
  if (raw === undefined) return null
  if (!isValidTikTokReadingAdvertiserIds(raw)) return null
  const ids: number[] = []
  for (const piece of raw.split(/[,，;；\s]+/)) {
    if (!piece) continue
    const id = Number.parseInt(piece, 10)
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids.length > 0 ? ids : null
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Inclusive local-date window for a range: '1' is today only, '7'/'28'
 * include today (whose row is partial — same convention as the refresh
 * service's 7-day window).
 */
export function tiktokReadingRangeWindow(
  range: TikTokReadingRange,
  today: Date = new Date()
): { startDate: string; endDate: string } {
  const endDate = formatLocalDate(today)
  if (range === '1') return { startDate: endDate, endDate }
  const start = new Date(today)
  start.setDate(start.getDate() - (range === '7' ? 6 : 27))
  return { startDate: formatLocalDate(start), endDate }
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
 * report per advertiser (or token-scoped when the grant list is empty) →
 * aggregate. Errors surface as `{ ok: false, error }` with the stable
 * 'no-credentials' code when neither token source holds a token.
 */
export async function buildTikTokReadingSummary(
  input: { advertiserIds?: unknown; range?: unknown } = {},
  deps: TikTokReadingDeps = {}
): Promise<TikTokReadingResult> {
  const range = isTikTokReadingRange(input.range) ? input.range : '7'
  const overrideIds = parseTikTokReadingAdvertiserIds(input.advertiserIds)
  if (input.advertiserIds !== undefined && overrideIds === null) {
    return { ok: false, error: 'invalid-input' }
  }
  const resolve = deps.resolveToken ?? resolveTikTokToken
  const resolved = await resolve()
  if (!resolved.token) {
    return { ok: false, error: 'no-credentials' }
  }
  const { startDate, endDate } = tiktokReadingRangeWindow(range, new Date(deps.now?.() ?? Date.now()))
  const grantedIds = overrideIds ?? resolved.advertiserIds
  const queries = grantedIds.length > 0 ? grantedIds.slice(0, MAX_ADVERTISERS_PER_SUMMARY) : [undefined]
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  try {
    const rows: TikTokReportRow[] = []
    for (const advertiserId of queries) {
      rows.push(
        ...(await fetchIntegratedReport(fetchImpl, {
          accessToken: resolved.token,
          startDate,
          endDate,
          ...(advertiserId !== undefined ? { advertiserId } : {})
        }))
      )
    }
    const { totals, topCampaigns } = summarizeTikTokReportRows(rows)
    const summary: TikTokReadingSummary = {
      range,
      startDate,
      endDate,
      totals,
      topCampaigns,
      source: resolved.source,
      generatedAt: deps.now?.() ?? Date.now()
    }
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message.slice(0, 300) }
  }
}
