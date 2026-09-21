import {
  isTikTokReadingRange,
  type TikTokReadingRange,
  type TikTokReadingResult,
  type TikTokReadingSummary,
  type TikTokReadingTopCampaign,
  type TikTokReadingTotals
} from '../../../shared/tiktokReport'
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
 * grouped by name, summed by spend and cut to the top 5.
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
  const byCampaign = new Map<string, number>()
  for (const row of rows) {
    const name = row.campaignName || '—'
    const value = typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0
    byCampaign.set(name, (byCampaign.get(name) ?? 0) + value)
  }
  const topCampaigns = [...byCampaign.entries()]
    .map(([name, campaignSpend]) => ({ name, spend: campaignSpend }))
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
