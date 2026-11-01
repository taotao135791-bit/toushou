import { previousEqualWindow } from './todayReading'

/** A model proposal is untrusted until Main binds it to a saved snapshot. */
export const BOARD_HIGHLIGHTS_FENCE = 'board-highlights'
export const BOARD_HIGHLIGHTS_LIMITS = { maxBytes: 32_768, maxHighlights: 8, maxEvidence: 2, maxText: 280, maxAccounts: 50 } as const
export const BOARD_HIGHLIGHT_METRICS = ['spend', 'previousSpend', 'impressions', 'clicks', 'conversions'] as const
export type BoardHighlightMetric = typeof BOARD_HIGHLIGHT_METRICS[number]
export interface BoardHighlightRef { accountIndex: number; metric: BoardHighlightMetric; value: number }
export interface BoardHighlight { text: string; evidence: BoardHighlightRef[] }
export interface BoardHighlightsProposal { version: 1; boardId: string; widgetId: string; revision: string; highlights: BoardHighlight[] }
export interface BoardHighlightAccountEvidence {
  index: number; name: string | null; accountId: string | null; resultType: string | null; platform: 'facebook' | 'tiktok' | 'google'; status: 'ok' | 'failed' | 'unattempted' | 'unavailable'
  window: { start: string; end: string }; previousWindow: { start: string; end: string } | null
  sourceAt: number | null; currency: string | null
  metrics: Record<BoardHighlightMetric, number | null>
}
export interface BoardHighlightEvidence { boardId: string; widgetId: string; revision: string; capturedAt: number; accounts: BoardHighlightAccountEvidence[]; omittedCount: number }
export type BoardHighlightsError = 'invalid-input' | 'not-found' | 'invalid-snapshot' | 'stale-evidence' | 'invalid-evidence' | 'private-text' | 'board-locked' | 'board-full' | 'write-failed'
export type BoardHighlightsEvidenceResult = { ok: true; evidence: BoardHighlightEvidence } | { ok: false; error: BoardHighlightsError }
export type BoardHighlightsValidationResult = { ok: true; proposal: BoardHighlightsProposal; evidence: BoardHighlightEvidence } | { ok: false; error: BoardHighlightsError }
export type BoardHighlightsApplyResult = { ok: true; boardId: string; widgetId: string; noteId: string } | { ok: false; error: BoardHighlightsError }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export function isBoardHighlightId(value: unknown): value is string { return uuid(value) }

/** Fail closed on any malformed claim, unknown field, invalid value, or non-JSON input. */
export function parseBoardHighlights(raw: unknown): BoardHighlightsProposal | null {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > BOARD_HIGHLIGHTS_LIMITS.maxBytes) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!object(value) || !keys(value, ['version', 'boardId', 'widgetId', 'revision', 'highlights']) || value.version !== 1 || !uuid(value.boardId) || !uuid(value.widgetId) || typeof value.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.highlights) || value.highlights.length < 1 || value.highlights.length > BOARD_HIGHLIGHTS_LIMITS.maxHighlights) return null
  const highlights: BoardHighlight[] = []
  for (const highlight of value.highlights) {
    if (!object(highlight) || !keys(highlight, ['text', 'evidence']) || typeof highlight.text !== 'string') return null
    const text = highlight.text.trim()
    if (!text || text.length > BOARD_HIGHLIGHTS_LIMITS.maxText || /[\x00-\x1f\x7f<>]/.test(text) || /(?:https?:\/\/|www\.)/i.test(text) || !Array.isArray(highlight.evidence) || highlight.evidence.length < 1 || highlight.evidence.length > BOARD_HIGHLIGHTS_LIMITS.maxEvidence) return null
    const refs: BoardHighlightRef[] = []
    const seen = new Set<string>()
    for (const ref of highlight.evidence) {
      if (!object(ref) || !keys(ref, ['accountIndex', 'metric', 'value']) || !Number.isSafeInteger(ref.accountIndex) || (ref.accountIndex as number) < 1 || (ref.accountIndex as number) > BOARD_HIGHLIGHTS_LIMITS.maxAccounts || typeof ref.metric !== 'string' || !(BOARD_HIGHLIGHT_METRICS as readonly string[]).includes(ref.metric) || typeof ref.value !== 'number' || !Number.isFinite(ref.value) || ref.value < 0) return null
      const key = `${ref.accountIndex}:${ref.metric}`
      if (seen.has(key)) return null
      seen.add(key)
      refs.push({ accountIndex: ref.accountIndex as number, metric: ref.metric as BoardHighlightMetric, value: ref.value })
    }
    highlights.push({ text, evidence: refs })
  }
  return { version: 1, boardId: value.boardId, widgetId: value.widgetId, revision: value.revision, highlights }
}

/** Build a reviewable draft from a whitelist; never serialize caller-supplied metadata. */
export function buildBoardHighlightsPrompt(evidence: BoardHighlightEvidence, language: 'zh' | 'en' = 'zh'): string {
  if (!isBoardHighlightId(evidence?.boardId) || !isBoardHighlightId(evidence?.widgetId) || !/^sha256:[a-f0-9]{64}$/.test(evidence?.revision ?? '') || !Number.isSafeInteger(evidence?.capturedAt) || evidence.capturedAt < 0 || !Array.isArray(evidence?.accounts)) return ''
  const allowedPlatforms = ['facebook', 'tiktok', 'google']
  const allowedStatuses = ['ok', 'failed', 'unattempted', 'unavailable']
  const dateWindow = (v: unknown): { start: string; end: string } | null => {
    if (!object(v) || typeof v.start !== 'string' || typeof v.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.start) || !/^\d{4}-\d{2}-\d{2}$/.test(v.end)) return null
    return { start: v.start, end: v.end }
  }
  const accounts = evidence.accounts.slice(0, BOARD_HIGHLIGHTS_LIMITS.maxAccounts).flatMap((a) => {
    if (!object(a) || !Number.isSafeInteger(a.index) || (a.index as number) < 1 || (a.index as number) > 50 || typeof a.platform !== 'string' || !allowedPlatforms.includes(a.platform) || typeof a.status !== 'string' || !allowedStatuses.includes(a.status)) return []
    const window = dateWindow(a.window)
    if (!window) return []
    const previousWindow = dateWindow(a.previousWindow)
    const sourceAt = typeof a.sourceAt === 'number' && Number.isSafeInteger(a.sourceAt) && a.sourceAt >= 0 && a.sourceAt <= evidence.capturedAt ? a.sourceAt : null
    const currency = typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency) ? a.currency : null
    const metrics: Record<BoardHighlightMetric, number | null> = { spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }
    const expectedPrevious = previousEqualWindow(window)
    const previousMatches = !!previousWindow && !!expectedPrevious && previousWindow.start === expectedPrevious.start && previousWindow.end === expectedPrevious.end
    if (a.status === 'ok' && sourceAt !== null && object(a.metrics)) for (const metric of BOARD_HIGHLIGHT_METRICS) {
      const value = a.metrics[metric]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!(metric === 'spend' || metric === 'previousSpend') || currency) && (metric !== 'previousSpend' || previousMatches)) metrics[metric] = value
    }
    const bounded = (v: unknown, limit: number) => typeof v === 'string' && v.length <= limit && !/[\x00-\x1f\x7f]/.test(v) ? v : null
    return [{ index: a.index, name: bounded(a.name, 200), accountId: bounded(a.accountId, 128), resultType: bounded(a.resultType, 100), platform: a.platform, status: a.status, window, previousWindow, sourceAt, currency, metrics }]
  })
  const projection = { boardId: evidence.boardId, widgetId: evidence.widgetId, revision: evidence.revision, capturedAt: evidence.capturedAt, accounts, omittedCount: Math.max(0, Math.min(1000, Number.isSafeInteger(evidence.omittedCount) ? evidence.omittedCount : 0)) }
  const zh = language === 'zh'
  return [
    zh ? '只根据以下已保存快照提出高光。不要调用工具或修改广告；不确定的信息写未知，不推断因果。不同平台结果定义可能不同，不混合汇总或比较；快照不保证实时。每条高光必须引用有来源时间、状态 ok 的账户中非空的指标，数值必须完全相同；不要引用失败、未知或省略的账户。文字仅供人工审核。' : 'Propose highlights only from this saved snapshot. Do not call tools or modify ads. Treat missing information as unknown and do not infer causality. Result definitions can differ across platforms; do not combine or compare them. The snapshot may not be live. Each highlight must cite a non-null value from an ok account with a source time, exactly matching the number; never cite failed, unknown or omitted accounts. Text is subject to human review.',
    zh ? '请返回恰好一个 board-highlights JSON 代码块；可以使用账户名称和 ID，不要包含网址或额外字段。格式：' : 'Return exactly one board-highlights JSON code block, account names and IDs are allowed; omit URLs and extra fields. Format:',
    '```board-highlights',
    JSON.stringify({ version: 1, boardId: evidence.boardId, widgetId: evidence.widgetId, revision: evidence.revision, highlights: [{ text: zh ? '供审核的观察' : 'Observation for review', evidence: [{ accountIndex: 1, metric: 'spend', value: 0 }] }] }, null, 2),
    '```',
    zh ? '示例中的数值仅示意，必须替换为下方对应账户的真实非空数值；若没有可引用的指标，请不要输出代码块。' : 'Example values are placeholders; replace them with matching non-null values below. If no value is available, do not output a code block.',
    JSON.stringify(projection)
  ].join('\n')
}

