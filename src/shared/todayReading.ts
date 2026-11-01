import { boardReadingRangeDates, fbDateString, type FbReadingRange } from './fbReading'
import type { ReadingErrorCode, ReadingFailure } from './readingError'
import { formatTikTokAmount, type TikTokReadingAdvertiser, type TikTokReadingRange } from './tiktokReport'

/** Morning page windows. last3 is intentionally absent: TikTok has no 3-day preset. */
export type TodayRange = 'today' | 'yesterday' | 'last3' | 'last7' | 'last28' | 'last30'
export type TikTokTodayRange = TodayRange | 'custom'

/** Maximum current-window length; comparison adds an equally long preceding window. */
export const TIKTOK_CUSTOM_MAX_DAYS = 366

/** An explicit ID reads only that authorized advertiser; omission uses the connection selection. */
export interface TikTokTodayReadingInput {
  range?: string
  startDate?: string
  endDate?: string
  advertiserId?: string
  requestId?: string
}

export interface TodayWindow {
  start: string
  end: string
}

export interface TodayCampaignMove {
  key?: string
  name: string
  spend: number
  previousSpend: number | null
  delta: number | null
}

export interface TodayChatRow {
  platform: string
  name: string
  status: string
  spend: string | null
  delta: string | null
  movers: string[]
}

/** Morning TikTok row. previousSpend is 0 when the earlier window had no spend. */
export interface TikTokTodayAccountReading extends TikTokReadingAdvertiser {
  /** Date windows are per-account and calculated using its own timezone. */
  window?: TodayWindow
  previousWindow?: TodayWindow
  spend: number
  previousSpend: number
  impressions: number
  clicks: number
  conversions: number
  campaigns: TodayCampaignMove[]
}

/** One account failed on its own; the other rows still show. */
export interface TikTokTodayAccountFailure extends TikTokReadingAdvertiser {
  error: ReadingErrorCode
  detail?: string
}

export type TikTokTodayAccount = TikTokTodayAccountReading | TikTokTodayAccountFailure

export function isTikTokTodayFailure(account: TikTokTodayAccount): account is TikTokTodayAccountFailure {
  return 'error' in account
}

export interface TikTokTodayReading {
  range: TikTokTodayRange
  window: TodayWindow
  previousWindow: TodayWindow
  source: 'oauth' | 'pasted'
  generatedAt: number
  /** True when the token grant has more advertisers than this page queries. */
  truncated: boolean
  accounts: TikTokTodayAccount[]
  /** Cancellation keeps completed rows and marks remaining accounts as unattempted. */
  cancelled?: boolean
  datasetSync?: { ok: true; legacyBackups?: string[] } | { ok: false; error: string }
}

/** One bounded account result, delivered only to the window owning the request. */
export type TikTokTodayProgressItem = Pick<TikTokTodayReading, 'range' | 'window' | 'previousWindow' | 'source' | 'generatedAt'> & { account: TikTokTodayAccount }

export type TikTokTodayReadingResult = TikTokTodayReading | ReadingFailure

const RANGE_DAYS: Record<Exclude<TodayRange, 'today' | 'yesterday'>, number> = {
  last3: 3,
  last7: 7,
  last28: 28,
  last30: 30
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null
}

/** Validate exact calendar dates and the service's explicit range bound. */
export function parseTikTokCustomWindow(startDate: unknown, endDate: unknown): TodayWindow | null {
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return null
  const parse = (raw: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw.startsWith('0000-')) return null
    const [year, month, day] = raw.split('-').map(Number)
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(0, 0, 0, 0)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    return date.getTime()
  }
  const start = parse(startDate), end = parse(endDate)
  if (start === null || end === null || end < start) return null
  const days = (end - start) / 86_400_000 + 1
  if (days > TIKTOK_CUSTOM_MAX_DAYS) return null
  // The previous comparison must also fit in a four-digit ISO date.
  if (new Date(start - days * 86_400_000).getUTCFullYear() < 1) return null
  return { start: startDate, end: endDate }
}

export function isTodayRange(value: unknown): value is TodayRange {
  return (
    value === 'today' ||
    value === 'yesterday' ||
    value === 'last3' ||
    value === 'last7' ||
    value === 'last28' ||
    value === 'last30'
  )
}

/**
 * Complete-day windows ending yesterday, except "today".
 * last7 matches the verified Facebook preset so stored readings line up.
 */
export function todayWindow(range: TodayRange, today: Date = new Date()): TodayWindow {
  if (range === 'today') {
    const day = fbDateString(today)
    return { start: day, end: day }
  }
  if (range === 'yesterday') {
    const day = new Date(today)
    day.setDate(day.getDate() - 1)
    const iso = fbDateString(day)
    return { start: iso, end: iso }
  }
  const days = RANGE_DAYS[range]
  const end = new Date(today)
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  return { start: fbDateString(start), end: fbDateString(end) }
}

/** Preset date windows relative to a verified account-local calendar day. */
export function todayWindowForAccountDate(range: TodayRange, accountDay: string): TodayWindow | null {
  const day = parseIsoDate(accountDay)
  if (!day) return null
  const offset = range === 'today' ? 0 : 1
  const days = range === 'today' || range === 'yesterday' ? 1 : RANGE_DAYS[range]
  const end = day.getTime() - offset * 86_400_000
  const start = end - (days - 1) * 86_400_000
  if (new Date(start).getUTCFullYear() < 1) return null
  return { start: new Date(start).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10) }
}

/** Board TT module window, on the today page's terms: '7' and '28' end yesterday. */
export function tiktokReadingRangeWindow(range: TikTokReadingRange, today: Date = new Date()): TodayWindow {
  if (range === '3') return todayWindow('last3', today)
  if (range === 'yd') return todayWindow('yesterday', today)
  if (range === '30') return todayWindow('last30', today)
  return todayWindow(range === '1' ? 'today' : range === '28' ? 'last28' : 'last7', today)
}

export function formatReadingWindow(window: TodayWindow): string {
  return window.start === window.end ? window.start : `${window.start} – ${window.end}`
}

export function previousEqualWindow(window: TodayWindow): TodayWindow | null {
  const start = parseIsoDate(window.start)
  const end = parseIsoDate(window.end)
  if (!start || !end || start.getTime() > end.getTime()) return null
  const days = (end.getTime() - start.getTime()) / 86_400_000 + 1
  if (!Number.isFinite(days) || days < 1) return null
  const prevEnd = start.getTime() - 86_400_000
  const prevStart = prevEnd - (days - 1) * 86_400_000
  if (new Date(prevStart).getUTCFullYear() < 1) return null
  return { start: new Date(prevStart).toISOString().slice(0, 10), end: new Date(prevEnd).toISOString().slice(0, 10) }
}

/** Facebook browser presets that are the same window. last28 has none. */
export function fbPresetForTodayRange(range: TodayRange): FbReadingRange | null {
  if (range === 'today') return 'today'
  if (range === 'yesterday') return 'yesterday'
  if (range === 'last3') return 'last3'
  if (range === 'last7') return 'last7'
  return null
}

export function todayWindowMatchesFbPreset(range: TodayRange, today: Date = new Date()): boolean {
  const preset = fbPresetForTodayRange(range)
  if (!preset) return false
  const fb = boardReadingRangeDates(preset, today)
  const window = todayWindow(range, today)
  return fb.start === window.start && fb.end === window.end
}

export function formatSpendDelta(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  const delta = current - previous
  const body = formatTikTokAmount(Math.abs(delta))
  if (delta > 0) return `+${body}`
  if (delta < 0) return `−${body}`
  return body
}

export function topSpendMoves(
  current: Array<{ name: string; spend: number }>,
  previous: Array<{ name: string; spend: number }> | null,
  limit = 3
): TodayCampaignMove[] {
  const previousByName = new Map((previous ?? []).map((row) => [row.name, row.spend]))
  const currentByName = new Map(current.map((row) => [row.name, row.spend]))
  const names = new Set<string>([...currentByName.keys(), ...previousByName.keys()])
  const moves: TodayCampaignMove[] = []
  for (const name of names) {
    if (!name.trim()) continue
    const spend = currentByName.get(name) ?? 0
    const previousSpend = previous ? (previousByName.get(name) ?? 0) : null
    const delta = previousSpend === null ? null : spend - previousSpend
    if (spend === 0 && (previousSpend ?? 0) === 0) continue
    moves.push({ name, spend, previousSpend, delta })
  }
  moves.sort((a, b) => {
    if (a.delta !== null && b.delta !== null) {
      const byMove = Math.abs(b.delta) - Math.abs(a.delta)
      if (byMove !== 0) return byMove
    }
    return b.spend - a.spend || a.name.localeCompare(b.name)
  })
  return moves.slice(0, Math.max(0, limit))
}

export function sumFinite(values: Array<number | null | undefined>): number | null {
  let total = 0
  let any = false
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      any = true
    }
  }
  return any ? total : null
}

/** Composer draft for "让投手看这组数". Missing figures stay missing. */
export function buildTodayChatPrompt(
  language: 'zh' | 'en',
  rangeLabel: string,
  windowLabel: string,
  rows: TodayChatRow[]
): string {
  const lines = rows.map((row) => {
    const spend = row.spend ?? (language === 'zh' ? '没有这个窗口的数' : 'no figure for this window')
    const delta = row.delta
      ? (language === 'zh' ? `较上一窗口 ${row.delta}` : `vs previous window ${row.delta}`)
      : (language === 'zh' ? '没有上一窗口' : 'no previous window')
    const movers = row.movers.length > 0
      ? (language === 'zh' ? `变动最大：${row.movers.join('，')}` : `largest moves: ${row.movers.join(', ')}`)
      : ''
    return `- ${row.platform} · ${row.name} · ${row.status} · ${spend} · ${delta}${movers ? ` · ${movers}` : ''}`
  })
  const body = lines.length > 0
    ? lines.join('\n')
    : (language === 'zh' ? '- 还没有账户或连接。' : '- No accounts or connections yet.')
  if (language === 'zh') {
    return [
      '请根据下面这组今日读数，告诉我下一步该看哪些账户或活动。',
      '这些数字是应用已经拿到的核对结果或官方报表。没有写出来的就当不知道，不要用别的日期或估算补上。',
      '',
      `日期：${rangeLabel}（${windowLabel}）`,
      '',
      body
    ].join('\n')
  }
  return [
    'Using the reading below, tell me which accounts or campaigns to look at next.',
    'These figures are verified readings or the official report. If a figure is absent, treat it as unknown. Do not fill it from another date or an estimate.',
    '',
    `Range: ${rangeLabel} (${windowLabel})`,
    '',
    body
  ].join('\n')
}
