/**
 * Board one-click reading (Phase A): parameter -> natural-language request,
 * plus a status projection derived from real session state.
 *
 * The prompt is intentionally Chinese regardless of UI language: the
 * downstream alias table, URL grammar and FB reading skill are keyed on
 * Chinese aliases (e.g. 三国IOS), and mixing locales would only widen the
 * parser's failure surface.
 */

export type BoardReadingMetric = 'spend' | 'cpi' | 'cpm' | 'cpa'
export type BoardReadingRange = 'today' | 'last3' | 'last7' | 'last30'

/** Lifecycle of one launch, derived from store state — never a timer. */
export type BoardReadingPhase =
  | 'pending' /* session created, prompt not yet visible in the transcript */
  | 'reading' /* user message landed and the session is busy */
  | 'done' /* turn finished; cards (if any) wait in chat for Apply */
  | 'failed' /* send failed — the message is flagged or nothing landed */

export interface BoardReadingLaunch {
  sessionId: string
  prompt: string
  startedAt: number
}

export interface BoardReadingMessageLike {
  role: 'user' | 'assistant' | 'system'
  kind?: 'prompt' | 'steer'
  content: string
  failed?: boolean
}

export const BOARD_READING_ACCOUNTS = ['三国IOS'] as const
export type BoardReadingAccount = (typeof BOARD_READING_ACCOUNTS)[number]

/**
 * Alias → Ads Manager target, kept in sync with the team alias table in
 * resources/browser-use-toolkit/skills/browser-use/SKILL.md. The renderer
 * builds the canonical URL itself so the request never depends on the model
 * re-deriving act/business ids or date-parameter grammar.
 */
const BOARD_READING_ACCOUNT_TARGETS: Record<BoardReadingAccount, { act: string; businessId: string }> = {
  三国IOS: { act: '2131017261144314', businessId: '1734414010144999' }
}

export const BOARD_READING_RANGE_LABELS: Record<BoardReadingRange, string> = {
  today: '今天',
  last3: '近3天',
  last7: '近7天',
  last30: '近30天'
}

export const BOARD_READING_METRIC_LABELS: Record<BoardReadingMetric, string> = {
  spend: '消耗',
  cpi: 'CPI',
  cpm: 'CPM',
  cpa: 'CPA'
}

function fbDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * FB "last N days" excludes today (verified against Ads Manager on 2026-09-16:
 * last_7d resolved to Sep 9–15 with Sep 16 as today), so ranges run from
 * today-N to yesterday; "today" is today alone. The preset token rides along
 * as a fallback label while the explicit dates stay authoritative.
 */
export function boardReadingRangeDates(
  range: BoardReadingRange,
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

/**
 * Canonical Ads Manager URL: date and insights_date MUST be paired with the
 * same <start>_<end>,<preset> value or Ads Manager silently ignores them.
 */
export function buildBoardReadingUrl(
  account: BoardReadingAccount,
  range: BoardReadingRange,
  today: Date = new Date()
): string {
  const target = BOARD_READING_ACCOUNT_TARGETS[account]
  const { start, end, preset } = boardReadingRangeDates(range, today)
  const dates = `${start}_${end},${preset}`
  return (
    `https://adsmanager.facebook.com/adsmanager/manage/campaigns` +
    `?act=${target.act}&business_id=${target.businessId}` +
    `&date=${dates}&insights_date=${dates}`
  )
}

/**
 * Build the natural-language reading request. Metrics must be non-empty and
 * de-duplicated in fixed order so the same selection always yields the same
 * sentence (the launch status later matches the prompt verbatim).
 */
export function buildBoardReadingPrompt(
  account: BoardReadingAccount,
  range: BoardReadingRange,
  metrics: readonly BoardReadingMetric[],
  today: Date = new Date()
): string | null {
  const ordered = (Object.keys(BOARD_READING_METRIC_LABELS) as BoardReadingMetric[]).filter((m) =>
    metrics.includes(m)
  )
  if (ordered.length === 0) return null
  const metricText = ordered.map((m) => BOARD_READING_METRIC_LABELS[m]).join('、')
  const url = buildBoardReadingUrl(account, range, today)
  return [
    `请读取「${account}」${BOARD_READING_RANGE_LABELS[range]}的${metricText}，并生成可由我点击 Apply 应用的 board-cards 提议。`,
    `规范入口 URL（参数已含成对 date 与 insights_date，直接 browser_navigate 使用，不要自行改动参数）：${url}`,
    'Facebook 全程只读；数据仅使用 browser_report 中 verified=true 的结果，或账户、日期及指标口径匹配的 fb_history。',
    '未登录时请提示我先在浏览器面板登录；指标缺失、验证失败或日期不匹配时请说明原因，不猜测、不用其他口径补齐。',
    '禁止修改预算、出价及其他广告设置。'
  ].join('')
}

/**
 * Project a launch into a UI phase from the SAME store slices the chat uses:
 * the optimistic user bubble (messages) and the busy map. "Sent" therefore
 * means the message actually landed in the transcript un-flagged — setting a
 * prefill alone never reports success.
 */
export function deriveBoardReadingPhase(
  launch: BoardReadingLaunch | null | undefined,
  messages: BoardReadingMessageLike[] | undefined,
  busy: boolean | undefined
): BoardReadingPhase | null {
  if (!launch) return null
  const sent = (messages ?? []).some(
    (m) => m.role === 'user' && m.kind !== 'steer' && m.content === launch.prompt
  )
  const failed = (messages ?? []).some(
    (m) => m.role === 'user' && m.kind !== 'steer' && m.content === launch.prompt && m.failed === true
  )
  if (failed) return 'failed'
  if (!sent) return 'pending'
  return busy ? 'reading' : 'done'
}
