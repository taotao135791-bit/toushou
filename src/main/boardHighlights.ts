import { createHash } from 'node:crypto'
import { BOARD_LIMITS, WIDGET_DEFAULT_SIZES, createWidget, findFreeSlot } from '../shared/boards'
import { BOARD_HIGHLIGHTS_LIMITS, isBoardHighlightId, parseBoardHighlights, type BoardHighlightEvidence, type BoardHighlightsApplyResult, type BoardHighlightsError, type BoardHighlightsEvidenceResult, type BoardHighlightsProposal, type BoardHighlightsValidationResult } from '../shared/boardHighlights'
import { validateReadingSnapshot, type ReadingSnapshot } from '../shared/readingSnapshot'
import { previousEqualWindow } from '../shared/todayReading'
import type { KanbanBoard } from '../shared/types'
import { listBoards, saveBoard } from './boards'

interface Deps { list?: () => KanbanBoard[]; save?: (board: KanbanBoard) => ReturnType<typeof saveBoard> }
interface Source { board: KanbanBoard; snapshot: ReadingSnapshot; evidence: BoardHighlightEvidence }

/** Revision changes whenever the board identity, source widget or snapshot changes. */
function revision(boardId: string, widgetId: string, snapshot: ReadingSnapshot): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([boardId, widgetId, snapshot]), 'utf8').digest('hex')}`
}

function findSource(boardId: unknown, widgetId: unknown, deps: Deps): Source | { error: 'invalid-input' | 'not-found' | 'invalid-snapshot' } {
  if (!isBoardHighlightId(boardId) || !isBoardHighlightId(widgetId)) return { error: 'invalid-input' }
  let boards: KanbanBoard[]
  try { boards = (deps.list ?? listBoards)() } catch { return { error: 'not-found' } }
  const board = boards.find(item => item.id === boardId)
  const widget = board?.widgets.find(item => item.id === widgetId && item.type === 'reading-snapshot')
  if (!board || !widget) return { error: 'not-found' }
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  if (!snapshot) return { error: 'invalid-snapshot' }
  const accounts = snapshot.accounts.slice(0, BOARD_HIGHLIGHTS_LIMITS.maxAccounts).map((a, index) => ({
    index: index + 1, platform: a.platform, status: a.status, window: a.window, previousWindow: a.previousWindow,
    sourceAt: a.sourceAt, currency: a.currency,
    metrics: { spend: a.spend, previousSpend: a.previousSpend, impressions: a.impressions, clicks: a.clicks, conversions: a.conversions }
  }))
  return { board, snapshot, evidence: { boardId, widgetId, revision: revision(boardId, widgetId, snapshot), capturedAt: snapshot.capturedAt, accounts, omittedCount: snapshot.accounts.length - accounts.length } }
}

export function getBoardHighlightEvidence(raw: unknown, deps: Deps = {}): BoardHighlightsEvidenceResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-input' }
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !['boardId', 'widgetId'].includes(key))) return { ok: false, error: 'invalid-input' }
  const source = findSource(input.boardId, input.widgetId, deps)
  return 'error' in source ? { ok: false, error: source.error } : { ok: true, evidence: source.evidence }
}

/** Account identifiers and names stay on this machine, even if a model guessed one. */
function hasPrivateText(proposal: BoardHighlightsProposal, snapshot: ReadingSnapshot): boolean {
  const text = proposal.highlights.map(item => item.text.toLocaleLowerCase()).join('\n')
  return snapshot.accounts.some(account => [account.accountId, account.name].some(raw => {
    const value = raw?.trim().toLocaleLowerCase()
    if (!value || ['tiktok', 'facebook', 'google'].includes(value)) return false
    return text.includes(value)
  }))
}

function verify(raw: unknown, deps: Deps): (Source & { proposal: BoardHighlightsProposal }) | { error: BoardHighlightsError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid-input' }
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 1 || !('raw' in value)) return { error: 'invalid-input' }
  const proposal = parseBoardHighlights(value.raw)
  if (!proposal) return { error: 'invalid-input' }
  const source = findSource(proposal.boardId, proposal.widgetId, deps)
  if ('error' in source) return source
  if (proposal.revision !== source.evidence.revision) return { error: 'stale-evidence' }
  if (hasPrivateText(proposal, source.snapshot)) return { error: 'private-text' }
  for (const item of proposal.highlights) {
    const verified: Array<{ account: BoardHighlightEvidence['accounts'][number]; metric: typeof item.evidence[number]['metric']; window: { start: string; end: string } }> = []
    for (const ref of item.evidence) {
      const account = source.evidence.accounts[ref.accountIndex - 1]
      const expectedPrevious = account?.window ? previousEqualWindow(account.window) : null
      if (!account || account.status !== 'ok' || account.sourceAt === null || account.sourceAt > source.evidence.capturedAt ||
          (ref.metric === 'previousSpend' && (!account.previousWindow || !expectedPrevious || account.previousWindow.start !== expectedPrevious.start || account.previousWindow.end !== expectedPrevious.end)) ||
          ((ref.metric === 'spend' || ref.metric === 'previousSpend') && !account.currency) ||
          account.metrics[ref.metric] === null || account.metrics[ref.metric] !== ref.value) return { error: 'invalid-evidence' }
      verified.push({ account, metric: ref.metric, window: ref.metric === 'previousSpend' ? account.previousWindow! : account.window })
    }
    if (verified.length > 1) {
      const first = verified[0]
      for (const next of verified.slice(1)) {
        if (first.account.index === next.account.index) continue
        if (first.account.platform !== next.account.platform || first.window.start !== next.window.start || first.window.end !== next.window.end ||
            first.metric === 'conversions' || next.metric === 'conversions' ||
            (['spend', 'previousSpend'].includes(first.metric) && ['spend', 'previousSpend'].includes(next.metric) && first.account.currency !== next.account.currency)) return { error: 'invalid-evidence' }
      }
    }
  }
  return { ...source, proposal }
}

export function validateBoardHighlights(raw: unknown, deps: Deps = {}): BoardHighlightsValidationResult {
  const result = verify(raw, deps)
  return 'error' in result ? { ok: false, error: result.error } : { ok: true, proposal: result.proposal, evidence: result.evidence }
}

const labels = { spend: '消耗', previousSpend: '上期消耗', impressions: '展示', clicks: '点击', conversions: '结果' } as const
function noteText(proposal: BoardHighlightsProposal, evidence: BoardHighlightEvidence): string {
  const lines = ['AI 高光（建议仅供人工复核；证据对应保存的读数快照）']
  proposal.highlights.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.text}`)
    for (const ref of item.evidence) {
      const account = evidence.accounts[ref.accountIndex - 1]
      const unit = (ref.metric === 'spend' || ref.metric === 'previousSpend') ? ` ${account.currency ?? '币种未知'}` : ''
      const window = ref.metric === 'previousSpend' ? account.previousWindow : account.window
      lines.push(`   证据：${account.platform} 账户 ${account.index} · ${window ? `${window.start} 至 ${window.end}` : '日期未知'} · ${labels[ref.metric]} ${ref.value}${unit}`)
    }
  })
  return lines.join('\n')
}

/** Idempotent user-confirmed local write. Evidence is checked again immediately before save. */
export function applyBoardHighlights(raw: unknown, deps: Deps = {}): BoardHighlightsApplyResult {
  const result = verify(raw, deps)
  if ('error' in result) return { ok: false, error: result.error }
  const { board, evidence, proposal } = result
  if (board.locked) return { ok: false, error: 'board-locked' }
  const text = noteText(proposal, evidence)
  if (text.length > BOARD_LIMITS.maxNoteLength) return { ok: false, error: 'invalid-input' }
  // Stable UUID for this source/proposal prevents an accidental double apply.
  const digest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  const noteId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  const prior = board.widgets.find(widget => widget.id === noteId)
  if (prior) return prior.type === 'note' && prior.config.text === text ? { ok: true, boardId: board.id, widgetId: proposal.widgetId, noteId } : { ok: false, error: 'write-failed' }
  if (board.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'board-full' }
  const note = createWidget('note', '读数高光（需复核）', findFreeSlot(board.widgets, WIDGET_DEFAULT_SIZES.note.w, WIDGET_DEFAULT_SIZES.note.h), { text })
  note.id = noteId
  const next = { ...board, widgets: [...board.widgets, note], updatedAt: Math.max(Date.now(), board.updatedAt + 1) }
  try {
    const saved = (deps.save ?? saveBoard)(next)
    return saved.ok ? { ok: true, boardId: board.id, widgetId: proposal.widgetId, noteId } : { ok: false, error: 'write-failed' }
  } catch { return { ok: false, error: 'write-failed' } }
}
