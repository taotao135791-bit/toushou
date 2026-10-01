import { boardReadingRangeDates, fbDateString, type FbReadingRange } from './fbReading'
import { formatTikTokAmount } from './tiktokReport'

/** Morning page windows. last3 is intentionally absent: TikTok has no 3-day preset. */
export type TodayRange = 'today' | 'last7' | 'last28'

export interface TodayWindow {
  start: string
  end: string
}

export interface TodayCampaignMove {
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
export interface TikTokTodayAccount {
  advertiserId: number | null
  spend: number
  previousSpend: number
  impressions: number
  clicks: number
  conversions: number
  campaigns: TodayCampaignMove[]
}

export interface TikTokTodayReading {
  range: TodayRange
  window: TodayWindow
  previousWindow: TodayWindow
  source: 'oauth' | 'pasted'
  generatedAt: number
  /** True when the token grant has more advertisers than this page queries. */
  truncated: boolean
  accounts: TikTokTodayAccount[]
}

export type TikTokTodayReadingResult = TikTokTodayReading | { ok: false; error: string }

const RANGE_DAYS: Record<Exclude<TodayRange, 'today'>, number> = {
  last7: 7,
  last28: 28
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null
}

export function isTodayRange(value: unknown): value is TodayRange {
  return value === 'today' || value === 'last7' || value === 'last28'
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
  const days = RANGE_DAYS[range]
  const end = new Date(today)
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  return { start: fbDateString(start), end: fbDateString(end) }
}

export function previousEqualWindow(window: TodayWindow): TodayWindow | null {
  const start = parseIsoDate(window.start)
  const end = parseIsoDate(window.end)
  if (!start || !end || fbDateString(start) > fbDateString(end)) return null
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  if (!Number.isFinite(days) || days < 1) return null
  const prevEnd = new Date(start)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevStart.getDate() - (days - 1))
  return { start: fbDateString(prevStart), end: fbDateString(prevEnd) }
}

/** Facebook browser presets that are the same window. last28 has none. */
export function fbPresetForTodayRange(range: TodayRange): FbReadingRange | null {
  if (range === 'today') return 'today'
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
