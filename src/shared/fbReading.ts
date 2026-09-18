/**
 * FB reading targets and URL grammar, shared by the renderer (prompt
 * building) and Main (refresh IPC): the same canonical URL drives both the
 * conversational path and the direct panel refresh.
 *
 * Ads Manager URL grammar: date and insights_date MUST be paired with the
 * same <start>_<exclusive-end> value. Do not invent preset tokens: last_3d
 * crashes the current Ads Manager component (reproduced 2026-09-17).
 * "last N days" excludes today (verified 2026-09-16).
 */

export type FbReadingRange = 'today' | 'last3' | 'last7' | 'last30'

/**
 * Account reference used by the local registry and snapshotted into widget
 * configs. Configs keep act/businessId so a module keeps working even if the
 * alias is later renamed or removed from the registry.
 */
export interface FbReadingAccountRef {
  alias: string
  act: string
  businessId: string | null
}

/** One row of the local account registry file (main-owned storage). */
export interface FbReadingAccountEntry extends FbReadingAccountRef {
  id: string
  createdAt: number
}

/** Accounts seeded on first run so legacy 三国IOS boards keep working. */
export const FB_READING_BUILTIN_ACCOUNTS: FbReadingAccountRef[] = [
  { alias: '三国IOS', act: '2131017261144314', businessId: '1734414010144999' }
]

export function isValidFbReadingAct(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6,20}$/.test(value)
}

export function isValidFbReadingBusinessId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{6,20}$/.test(value))
}

/** Resolve a widget config into an account ref; legacy aliases fall back to builtins. */
export function resolveFbReadingWidgetAccount(config: Record<string, unknown>): FbReadingAccountRef | null {
  const alias = typeof config.account === 'string' ? config.account.trim() : ''
  if (!alias) return null
  if (isValidFbReadingAct(config.act)) {
    return {
      alias,
      act: config.act,
      businessId: isValidFbReadingBusinessId(config.businessId) ? config.businessId : null
    }
  }
  const builtin = FB_READING_ACCOUNT_TARGETS[alias]
  return builtin ? { alias, act: builtin.act, businessId: builtin.businessId } : null
}

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
): { start: string; end: string } {
  if (range === 'today') {
    const s = fbDateString(today)
    return { start: s, end: s }
  }
  const n = range === 'last3' ? 3 : range === 'last7' ? 7 : 30
  const end = new Date(today)
  end.setDate(end.getDate() - 1)
  const start = new Date(today)
  start.setDate(start.getDate() - n)
  return { start: fbDateString(start), end: fbDateString(end) }
}

/** Visible Chinese date label, not the requested URL or an inferred preset. */
export function parseFbReadingDateRange(label: string | null): { start: string; end: string } | null {
  const text = label?.trim() ?? ''
  const match = text.match(/^(?:(?:今天|昨天|过去 \d+ 天|过去 \d+ 周|本月|上年)[：:]\s*)?(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*[–—-]\s*(\d{4})年(\d{1,2})月(\d{1,2})日)?$/)
  if (!match) return parseFbReadingDateRangeEn(label)
  const date = (offset: number): string | null => {
    const [y, m, d] = match.slice(offset, offset + 3).map(Number)
    const value = new Date(y, m - 1, d)
    return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d
      ? fbDateString(value)
      : null
  }
  const start = date(1)
  const end = match[4] ? date(4) : start
  return start && end && start <= end ? { start, end } : null
}

const FB_EN_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7,
  Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12
}

/** English-UI labels: "Sep 15 – Sep 17, 2026" / "Today: Sep 18, 2026". */
export function parseFbReadingDateRangeEn(label: string | null): { start: string; end: string } | null {
  const text = label?.trim() ?? ''
  const stripped = text.replace(/^(?:Today|Yesterday|Last \d+ days?|This month|This year|Last year)[：:]?\s*/, '')
  const single = stripped.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})$/)
  const range = stripped.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2}) – ([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})$/)
  const month = (name: string): number | null => FB_EN_MONTHS[name] ?? null
  const build = (y: number, m: number, d: number): string | null => {
    const value = new Date(y, m - 1, d)
    return value.getFullYear() === y && value.getMonth() === m - 1 && value.getDate() === d
      ? fbDateString(value)
      : null
  }
  if (range) {
    const m1 = month(range[1])
    const m2 = month(range[3])
    if (!m1 || !m2) return null
    const start = build(Number(range[5]), m1, Number(range[2]))
    const end = build(Number(range[5]), m2, Number(range[4]))
    return start && end && start <= end ? { start, end } : null
  }
  if (single) {
    const m = month(single[1])
    if (!m) return null
    const day = build(Number(single[3]), m, Number(single[2]))
    return day ? { start: day, end: day } : null
  }
  return null
}

export function fbReadingMatchesWindow(
  reading: { accountId: string | null; dateRangeLabel: string | null },
  accountId: string,
  window: { start: string; end: string }
): boolean {
  const actual = parseFbReadingDateRange(reading.dateRangeLabel)
  return reading.accountId === accountId && actual?.start === window.start && actual.end === window.end
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
  return buildFbReadingUrlForRef(
    target ? { alias: account, act: target.act, businessId: target.businessId } : null,
    range,
    today
  )
}

/** Canonical Ads Manager URL for one registry account reference. */
export function buildFbReadingUrlForRef(
  ref: FbReadingAccountRef | null,
  range: FbReadingRange,
  today: Date = new Date()
): string {
  if (!ref || !isValidFbReadingAct(ref.act)) return ''
  const { start, end } = boardReadingRangeDates(range, today)
  // UI/report dates are inclusive; Ads Manager's URL end is exclusive.
  const [year, month, day] = end.split('-').map(Number)
  const exclusiveEnd = fbDateString(new Date(year, month - 1, day + 1))
  const dates = `${start}_${exclusiveEnd}`
  return (
    'https://adsmanager.facebook.com/adsmanager/manage/campaigns' +
    `?act=${ref.act}${ref.businessId ? `&business_id=${ref.businessId}` : ''}` +
    `&date=${dates}&insights_date=${dates}`
  )
}
