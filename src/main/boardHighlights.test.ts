import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/unused-highlight-test' } }))
import { createBoard, createWidget } from '../shared/boards'
import type { KanbanBoard } from '../shared/types'
import type { ReadingSnapshot } from '../shared/readingSnapshot'
import { applyBoardHighlights, getBoardHighlightEvidence, validateBoardHighlights } from './boardHighlights'
import { saveReadingSnapshot } from './readingSnapshots'
import { listBoards, saveBoard } from './boards'

function fixture() {
  const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'PRIVATE_RANGE', window: { start: '2026-01-01', end: '2026-01-07' }, capturedAt: 100,
    accounts: [{ platform: 'tiktok', accountId: '7300000000000000001', name: 'PRIVATE_ACCOUNT', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: { start: '2025-12-25', end: '2025-12-31' }, sourceAt: 90, timezone: 'PRIVATE_ZONE', currency: 'USD', spend: 42, previousSpend: 30, impressions: 100, clicks: 10, conversions: 2 },
      { platform: 'facebook', accountId: '7300000000000000002', name: 'PRIVATE_FAILED', status: 'failed', statusDetail: 'private failure', window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null, sourceAt: null, timezone: null, currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }] }
  let board: KanbanBoard = createBoard('PRIVATE_BOARD', 10)
  const widget = createWidget('reading-snapshot', 'PRIVATE_TITLE', { x: 0, y: 0 }, { snapshot, includeChart: false })
  board.widgets = [widget]
  const save = vi.fn((next: KanbanBoard) => { board = next; return { ok: true as const } })
  const deps = { list: () => [board], save }
  const found = getBoardHighlightEvidence({ boardId: board.id, widgetId: widget.id }, deps)
  if (!found.ok) throw new Error(found.error)
  const proposal = { version: 1, boardId: board.id, widgetId: widget.id, revision: found.evidence.revision, highlights: [{ text: 'Review the spending', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }] }] }
  return { snapshot, widget, deps, save, found, proposal, getBoard: () => board, setBoard: (value: KanbanBoard) => { board = value } }
}

describe('evidence-linked board highlights', () => {
  it('exposes bounded account evidence and omits provider error details', () => {
    const f = fixture()
    const json = JSON.stringify(f.found)
    for (const secret of ['PRIVATE_RANGE', 'PRIVATE_ZONE', 'PRIVATE_BOARD', 'PRIVATE_TITLE', 'private failure']) expect(json).not.toContain(secret)
    expect(f.found.evidence.accounts).toMatchObject([{ index: 1, name: 'PRIVATE_ACCOUNT', accountId: '7300000000000000001', metrics: { spend: 42 } }, { index: 2, status: 'failed', metrics: { spend: null } }])
  })
  it('rejects wrong, stale, failed, unknown and mismatching evidence', () => {
    const f = fixture()
    const check = (proposal: unknown) => validateBoardHighlights({ raw: JSON.stringify(proposal) }, f.deps)
    expect(check(f.proposal)).toMatchObject({ ok: true })
    expect(check({ ...f.proposal, widgetId: '22222222-2222-4222-8222-222222222222' })).toEqual({ ok: false, error: 'not-found' })
    expect(check({ ...f.proposal, revision: `sha256:${'0'.repeat(64)}` })).toEqual({ ok: false, error: 'stale-evidence' })
    expect(check({ ...f.proposal, highlights: [{ text: 'Review', evidence: [{ accountIndex: 1, metric: 'spend', value: 999 }] }] })).toEqual({ ok: false, error: 'invalid-evidence' })
    expect(check({ ...f.proposal, highlights: [{ text: 'Review', evidence: [{ accountIndex: 2, metric: 'spend', value: 0 }] }] })).toEqual({ ok: false, error: 'invalid-evidence' })
    expect(check({ ...f.proposal, highlights: [{ text: 'PRIVATE_ACCOUNT spending', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }] }] })).toMatchObject({ ok: true })
    f.snapshot.accounts[0].spend = 43
    expect(check(f.proposal)).toEqual({ ok: false, error: 'stale-evidence' })
    expect(f.save).not.toHaveBeenCalled()
  })
  it('rejects a number without source time, currency or a prior comparison window', () => {
    for (const change of [{ sourceAt: null }, { currency: null }]) {
      const f = fixture()
      Object.assign(f.snapshot.accounts[0], change)
      const projected = getBoardHighlightEvidence({ boardId: f.proposal.boardId, widgetId: f.proposal.widgetId }, f.deps)
      if (!projected.ok) throw new Error(projected.error)
      expect(validateBoardHighlights({ raw: JSON.stringify({ ...f.proposal, revision: projected.evidence.revision }) }, f.deps)).toEqual({ ok: false, error: 'invalid-evidence' })
    }
    const f = fixture()
    f.snapshot.accounts[0].previousWindow = null
    const projected = getBoardHighlightEvidence({ boardId: f.proposal.boardId, widgetId: f.proposal.widgetId }, f.deps)
    if (!projected.ok) throw new Error(projected.error)
    const proposal = { ...f.proposal, revision: projected.evidence.revision, highlights: [{ text: 'Review', evidence: [{ accountIndex: 1, metric: 'previousSpend', value: 30 }] }] }
    expect(validateBoardHighlights({ raw: JSON.stringify(proposal) }, f.deps)).toEqual({ ok: false, error: 'invalid-evidence' })
  })
  it('rejects cross-platform, cross-currency or mismatched-window comparisons between accounts', () => {
    const f = fixture()
    f.snapshot.accounts[1] = { ...f.snapshot.accounts[0], accountId: '7300000000000000002', name: 'PRIVATE_SECOND', currency: 'EUR' }
    const projected = getBoardHighlightEvidence({ boardId: f.proposal.boardId, widgetId: f.proposal.widgetId }, f.deps)
    if (!projected.ok) throw new Error(projected.error)
    const proposal = { ...f.proposal, revision: projected.evidence.revision, highlights: [{ text: 'Review the two amounts', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }, { accountIndex: 2, metric: 'spend', value: 42 }] }] }
    expect(validateBoardHighlights({ raw: JSON.stringify(proposal) }, f.deps)).toEqual({ ok: false, error: 'invalid-evidence' })
    f.snapshot.accounts[1].currency = 'USD'
    f.snapshot.accounts[1].platform = 'facebook'
    const mixed = getBoardHighlightEvidence({ boardId: f.proposal.boardId, widgetId: f.proposal.widgetId }, f.deps)
    if (!mixed.ok) throw new Error(mixed.error)
    expect(validateBoardHighlights({ raw: JSON.stringify({ ...proposal, revision: mixed.evidence.revision }) }, f.deps)).toEqual({ ok: false, error: 'invalid-evidence' })
    f.snapshot.accounts[1].platform = 'tiktok'
    f.snapshot.accounts[1].window = { start: '2026-01-02', end: '2026-01-08' }
    const shifted = getBoardHighlightEvidence({ boardId: f.proposal.boardId, widgetId: f.proposal.widgetId }, f.deps)
    if (!shifted.ok) throw new Error(shifted.error)
    expect(validateBoardHighlights({ raw: JSON.stringify({ ...proposal, revision: shifted.evidence.revision }) }, f.deps)).toEqual({ ok: false, error: 'invalid-evidence' })
  })
  it('requires review/apply, rechecks proof, writes a reviewed note once and keeps the source intact', () => {
    const f = fixture(), raw = JSON.stringify(f.proposal)
    expect(f.save).not.toHaveBeenCalled()
    const applied = applyBoardHighlights({ raw }, f.deps)
    expect(applied.ok).toBe(true)
    expect(f.save).toHaveBeenCalledOnce()
    const board = f.getBoard()
    expect(board.widgets).toHaveLength(2)
    expect(board.widgets[0].config.snapshot).toEqual(f.snapshot)
    const note = String(board.widgets[1].config.text)
    expect(note).toContain('42 USD')
    expect(note).not.toContain('PRIVATE_ACCOUNT')
    expect(note).not.toContain('7300000000000000001')
    expect(applyBoardHighlights({ raw }, f.deps)).toEqual(applied)
    expect(f.save).toHaveBeenCalledOnce()
    f.setBoard({ ...board, widgets: board.widgets.filter(item => item.id !== f.widget.id) })
    expect(applyBoardHighlights({ raw }, f.deps)).toEqual({ ok: false, error: 'not-found' })
  })
  it('persists a reviewed note through the real board validator without rewriting the source', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'highlight-proof-'))
    try {
      const file = path.join(dir, 'boards.json')
      const f = fixture()
      const saved = saveReadingSnapshot({ name: 'Fixture', snapshot: f.snapshot, includeChart: false }, file)
      if (!saved.ok) throw new Error(saved.error)
      const widgetId = saved.widgetId
      const deps = { list: () => listBoards(file), save: (board: KanbanBoard) => saveBoard(board, file) }
      const evidence = getBoardHighlightEvidence({ boardId: saved.board.id, widgetId }, deps)
      if (!evidence.ok) throw new Error(evidence.error)
      const proposal = { ...f.proposal, boardId: saved.board.id, widgetId, revision: evidence.evidence.revision }
      const result = applyBoardHighlights({ raw: JSON.stringify(proposal) }, deps)
      expect(result.ok).toBe(true)
      const loaded = listBoards(file)[0]
      expect(loaded.widgets).toHaveLength(saved.board.widgets.length + 1)
      expect(loaded.widgets.find(widget => widget.id === saved.widgetId)?.config.snapshot).toEqual(f.snapshot)
      expect(loaded.widgets.slice(0, -1)).toEqual(saved.board.widgets)
      expect(String(loaded.widgets.at(-1)?.config.text)).toContain('42 USD')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
