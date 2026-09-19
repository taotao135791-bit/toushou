/**
 * Board one-click reading (Phase A): parameter -> natural-language request,
 * plus a status projection derived from real session state.
 *
 * The prompt is intentionally Chinese regardless of UI language: the
 * downstream alias table, URL grammar and FB reading skill are keyed on
 * Chinese aliases (e.g. 三国IOS), and mixing locales would only widen the
 * parser's failure surface.
 */

export type BoardReadingMetric = 'spend' | 'cpi' | 'cpm' | 'cpa' | 'ctr'
import { buildBoardReadingUrl as buildCanonicalUrl, boardReadingRangeDates as sharedRangeDates, FB_READING_ACCOUNT_TARGETS as ACCOUNT_TARGETS } from '../../shared/fbReading'
import type { FbReadingRange } from '../../shared/fbReading'

export type BoardReadingRange = FbReadingRange

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

/** Alias → Ads Manager target, shared with Main (see shared/fbReading.ts). */
const BOARD_READING_ACCOUNT_TARGETS = ACCOUNT_TARGETS as Record<
  BoardReadingAccount,
  { act: string; businessId: string }
>

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
  cpa: 'CPA',
  ctr: 'CTR'
}

/**
 * FB "last N days" excludes today (verified against Ads Manager on 2026-09-16:
 * last_7d resolved to Sep 9–15 with Sep 16 as today), so ranges run from
 * today-N to yesterday; "today" is today alone. These dates are inclusive.
 */
export function boardReadingRangeDates(
  range: BoardReadingRange,
  today: Date = new Date()
): { start: string; end: string } {
  return sharedRangeDates(range, today)
}

/**
 * Canonical Ads Manager URL: date and insights_date MUST be paired with the
 * same <start>_<exclusive-end> value, without unsupported preset tokens.
 */
export function buildBoardReadingUrl(
  account: BoardReadingAccount,
  range: BoardReadingRange,
  today: Date = new Date()
): string {
  return buildCanonicalUrl(account, range, today)
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
  const target = BOARD_READING_ACCOUNT_TARGETS[account]
  const { start, end } = boardReadingRangeDates(range, today)
  return [
    `请读取「${account}」${BOARD_READING_RANGE_LABELS[range]}的${metricText}，生成可由我点击 Apply 的 board-cards 提议。执行规则已内联，无需重读 skill 文档。`,
    `第1步（先做，命中即跳过实时读数）：fb_history 查 accountId=${target.act}；若存在 verified 读数满足 日期窗口=${start}~${end} 且含所需指标，直接用该读数执行第3步。字段口径：CPI = spend ÷ installs（仅当 resultType 是应用安装且 installs 缺失时才可用 results）；CPM = spend ÷ impressions × 1000；CTR = clicks ÷ impressions × 100；CPA = spend ÷ results，且仅当所有行 resultType 一致。禁止把 purchases 的 costPerResult 标成 CPI。`,
    `第2步（第1步未命中才做）：browser_navigate 到 ${url}（请求体带 "takeover": true，面板可能被上次会话占用；URL 参数已含成对 date 与 insights_date，勿改动），页面稳定后 browser_report；仅 verified=true 的结果可用。`,
    '第3步 出卡：board-cards 围栏 JSON 压成一行，顶层必须带 "version":1，例如 {"version":1,"cards":[{"type":"metric","title":"总消耗","value":1234.56,"unit":"USD"},{"type":"list","title":"系列明细","items":["_008 $100.00 · CPI $10.00"]}]}，数值只来自上述合规来源。',
    '硬约束：FB 全程只读，禁止修改预算、出价等一切设置；未登录时提示我先在浏览器面板登录；口径不匹配或指标缺失时如实说明原因，不猜测、不用其他口径补齐；实时读数失败后最多重试两次即如实拒报收尾，禁止把重试循环放到后台反复导航浏览器面板打扰用户。'
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
