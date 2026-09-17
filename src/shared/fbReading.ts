/**
 * FB reading targets and URL grammar, shared by the renderer (prompt
 * building) and Main (refresh IPC): the same canonical URL drives both the
 * conversational path and the direct panel refresh.
 *
 * Ads Manager URL grammar: date and insights_date MUST be paired with the
 * same <start>_<end>,<preset> value or the params are silently ignored.
 * "last N days" excludes today (verified 2026-09-16).
 */

export type FbReadingRange = 'today' | 'last3' | 'last7' | 'last30'

export const FB_READING_ACCOUNT_TARGETS: Record<string, { act: string; businessId: string }> = {
  三国IOS: { act: '2131017261144314', businessId: '1734414010144999' }
}

export function fbDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function boardReadingRangeDates(
  range: FbReadingRange,
  today: Date = new Date()
): { start: string; end: string; preset: string } {
  if (range === 'today') {
    const s = fbDateString(today)
    return { start: s, end: s, preset: 'today' }
  }
  const preset = range === 'last3' ? 'last_3d' : range === 'last7' ? 'last_7d' : 'last_30d'
  const n = range === 'last3' ? 3 : range === 'last7' ? 7 : 30
  const end = new Date(today)
  end.setDate(end.getDate() - 1)
  const start = new Date(today)
  start.setDate(start.getDate() - n)
  return { start: fbDateString(start), end: fbDateString(end), preset }
}

/** One campaign row of a verified reading (history projection shape). */
export interface FbReadingHistoryRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  results: number | null
  resultType: string | null
  clicks: number | null
  ctr: number | null
  cpc: number | null
  installs: number | null
}

/** A verified reading as stored in fb-readings.json and served to widgets. */
export interface FbReadingHistoryEntry {
  id: string
  capturedAt: string
  accountId: string
  accountName: string | null
  dateRangeLabel: string | null
  campaignCount: number | null
  totalSpend: number | null
  rows: FbReadingHistoryRow[]
}

/** Result of driving navigate + browser_report from the reading module. */
export type FbReadingRefreshResult =
  | { ok: true; entry: FbReadingHistoryEntry }
  | { ok: false; error: string }

/** History list for the reading module (latest verified entries first). */
export type FbReadingHistoryListResult = FbReadingHistoryEntry[]

export function buildBoardReadingUrl(account: string, range: FbReadingRange, today: Date = new Date()): string {
  const target = FB_READING_ACCOUNT_TARGETS[account]
  if (!target) return ''
  const { start, end, preset } = boardReadingRangeDates(range, today)
  const dates = `${start}_${end},${preset}`
  return (
    'https://adsmanager.facebook.com/adsmanager/manage/campaigns' +
    `?act=${target.act}&business_id=${target.businessId}` +
    `&date=${dates}&insights_date=${dates}`
  )
}
