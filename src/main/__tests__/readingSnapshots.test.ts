import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { saveReadingSnapshot } from '../readingSnapshots'
import { listBoards, saveBoard, deleteBoard } from '../boards'
import { BOARD_LIMITS, createWidget } from '../../shared/boards'
import type { ReadingSnapshot } from '../../shared/readingSnapshot'

const dirs: string[] = []
function file() { const dir = mkdtempSync(path.join(os.tmpdir(), 'reading-snapshot-test-')); dirs.push(dir); return path.join(dir, 'boards.json') }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const snapshot: ReadingSnapshot = {
  kind: 'reading-snapshot', version: 1, rangeLabel: '最近 7 天', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 1000,
  accounts: [
    { platform: 'tiktok', accountId: '123', name: 'Test A', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: { start: '2026-09-24', end: '2026-09-30' }, sourceAt: 900, timezone: 'UTC', currency: 'USD', spend: 12, previousSpend: 10, impressions: 100, clicks: 3, conversions: 1 },
    { platform: 'facebook', accountId: '456', name: 'Test B', status: 'failed', statusDetail: 'network', window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: null, timezone: null, currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }
  ]
}

describe('local immutable reading snapshot boards', () => {
  it('saves exact status, scope and source time in the ordinary board file', () => {
    const target = file()
    const result = saveReadingSnapshot({ presentation: 'report', name: ' Test ', snapshot, includeChart: true }, target)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.board.name).toBe('Test')
    const stored = listBoards(target)[0]
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(stored.widgets[0].type).toBe('reading-snapshot')
    expect(stored.widgets[0].config).toEqual({ snapshot, includeChart: true })
    snapshot.accounts[0].name = 'Changed in caller'
    expect(listBoards(target)[0].widgets[0].config.snapshot).not.toEqual(snapshot)
    snapshot.accounts[0].name = 'Test A'
  })
  it('does not report success or overwrite an unreadable store', () => {
    const target = file(); writeFileSync(target, '{broken')
    expect(saveReadingSnapshot({ presentation: 'report', name: 'Test', snapshot, includeChart: false }, target)).toEqual({ ok: false, error: 'board-store-unreadable' })
    expect(readFileSync(target, 'utf8')).toBe('{broken')
  })
  it('rejects invalid dates, malformed metric values, and failures represented as zero', () => {
    const target = file()
    const badDate = structuredClone(snapshot); badDate.window.start = '2026-02-31'
    const badMetric = structuredClone(snapshot); badMetric.accounts[0].spend = Infinity
    const failedZero = structuredClone(snapshot); failedZero.accounts[1].spend = 0
    for (const bad of [badDate, badMetric, failedZero]) expect(saveReadingSnapshot({ presentation: 'report', name: 'Test', snapshot: bad, includeChart: false }, target)).toEqual({ ok: false, error: 'invalid-input' })
    expect(listBoards(target)).toEqual([])
  })
  it('appends a new immutable snapshot to an existing board and preserves every old widget', () => {
    const target = file(), created = saveReadingSnapshot({ presentation: 'report', name: 'Test', snapshot, includeChart: false }, target)
    if (!created.ok) throw new Error('create failed')
    const previous = structuredClone(created.board)
    const changed = structuredClone(snapshot); changed.accounts[0].spend = 42
    const added = saveReadingSnapshot({ presentation: 'report', name: 'unused', snapshot: changed, includeChart: true, target: { kind: 'existing', boardId: previous.id, expectedUpdatedAt: previous.updatedAt } }, target)
    expect(added.ok).toBe(true)
    if (!added.ok) throw new Error('append failed')
    expect(added.board.id).toBe(previous.id)
    expect(added.board.widgets).toHaveLength(2)
    expect(added.board.widgets[0]).toEqual(previous.widgets[0])
    expect(added.widgetId).toBe(added.board.widgets[1].id)
    expect(added.board.widgets[1].config.snapshot).toEqual(changed)
    expect(added.board.widgets[1].layout.y).toBeGreaterThanOrEqual(previous.widgets[0].layout.y + previous.widgets[0].layout.h)
    changed.accounts[0].spend = 999
    expect((listBoards(target)[0].widgets[1].config.snapshot as ReadingSnapshot).accounts[0].spend).toBe(42)
    expect(listBoards(target)).toHaveLength(1)
  })
  it('refuses stale, locked, removed, full and malformed destinations without changing stored snapshots', () => {
    const target = file(), created = saveReadingSnapshot({ presentation: 'report', name: 'Test', snapshot, includeChart: false }, target)
    if (!created.ok) throw new Error('create failed')
    const board = created.board
    const args = { name: 'unused', snapshot, includeChart: false, target: { kind: 'existing', boardId: board.id, expectedUpdatedAt: board.updatedAt } } as const
    const renamed = { ...board, name: 'changed', updatedAt: board.updatedAt + 1 }
    expect(saveBoard(renamed, target, board.updatedAt)).toEqual({ ok: true })
    expect(saveReadingSnapshot(args, target)).toEqual({ ok: false, error: 'conflict' })
    const locked = { ...renamed, locked: true, updatedAt: renamed.updatedAt + 1 }
    expect(saveBoard(locked, target, renamed.updatedAt)).toEqual({ ok: true })
    expect(saveReadingSnapshot({ ...args, target: { ...args.target, expectedUpdatedAt: locked.updatedAt } }, target)).toEqual({ ok: false, error: 'board-locked' })
    const full = { ...locked, locked: false, widgets: [...locked.widgets, ...Array.from({ length: BOARD_LIMITS.maxWidgets - 1 }, (_, i) => createWidget('note', 'Fixture', { x: 0, y: i * 2 }))], updatedAt: locked.updatedAt + 1 }
    expect(saveBoard(full, target, locked.updatedAt)).toEqual({ ok: true })
    expect(saveReadingSnapshot({ ...args, target: { ...args.target, expectedUpdatedAt: full.updatedAt } }, target)).toEqual({ ok: false, error: 'board-full' })
    expect(listBoards(target)[0].widgets[0].config.snapshot).toEqual(snapshot)
    expect(saveReadingSnapshot({ ...args, target: { ...args.target, extra: true } }, target)).toEqual({ ok: false, error: 'invalid-input' })
    expect(deleteBoard(board.id, target)).toEqual({ ok: true })
    expect(saveReadingSnapshot(args, target)).toEqual({ ok: false, error: 'not-found' })
  })
  it('blocks mutation of a saved reading but permits normal board edits', () => {
    const target = file(); const result = saveReadingSnapshot({ presentation: 'report', name: 'Test', snapshot, includeChart: false }, target)
    if (!result.ok) throw new Error('save failed')
    const changed = structuredClone(result.board)
    const raw = changed.widgets[0].config.snapshot as ReadingSnapshot
    raw.accounts[0].spend = 13
    expect(saveBoard(changed, target)).toEqual({ ok: false, error: 'snapshot-immutable' })
    const moved = structuredClone(result.board); moved.name = 'Renamed'; moved.widgets[0].layout.y = 2
    expect(saveBoard(moved, target)).toEqual({ ok: true })
    expect((listBoards(target)[0].widgets[0].config.snapshot as ReadingSnapshot).accounts[0].spend).toBe(12)
  })
})


describe('independent reading modules', () => {
  it('saves the default modular board atomically with separate metric, charts, notes and complete source', () => {
    const target = file()
    const result = saveReadingSnapshot({ name: 'Modular', snapshot, includeChart: true }, target)
    if (!result.ok) throw Error(result.error)
    const modules = result.board.widgets.filter(widget => widget.type === 'reading-module')
    expect(modules).toHaveLength(7)
    expect(modules.filter(widget => (widget.config.module as { kind: string }).kind === 'metric')).toHaveLength(3)
    expect(modules.filter(widget => (widget.config.module as { kind: string }).kind === 'spend-chart')).toHaveLength(2)
    expect(result.focusWidgetId).toBe(modules[0].id)
    expect(result.widgetId).toBe(result.snapshotWidgetId)
    const source = result.board.widgets.find(widget => widget.id === result.snapshotWidgetId)
    expect(source?.type).toBe('reading-snapshot')
    expect(source?.config.snapshot).toEqual(snapshot)
    for (const widget of modules) {
      expect(widget.config.snapshot).toEqual(snapshot)
      expect(widget.layout.x + widget.layout.w).toBeLessThanOrEqual(12)
      for (const other of result.board.widgets.filter(other => other.id !== widget.id)) {
        const intersects = widget.layout.x < other.layout.x + other.layout.w && other.layout.x < widget.layout.x + widget.layout.w && widget.layout.y < other.layout.y + other.layout.h && other.layout.y < widget.layout.y + widget.layout.h
        expect(intersects).toBe(false)
      }
    }
    const changed = structuredClone(result.board)
    ;(changed.widgets[0].config.snapshot as ReadingSnapshot).accounts[0].spend = 999
    expect(saveBoard(changed, target)).toEqual({ ok: false, error: 'snapshot-immutable' })
    const rewritten = structuredClone(result.board)
    rewritten.widgets[0].config.module = { kind: 'metric', metric: 'clicks', accountIndex: 0 }
    expect(saveBoard(rewritten, target)).toEqual({ ok: false, error: 'snapshot-immutable' })
    const moved = structuredClone(result.board); moved.widgets[0].layout.h += 1
    expect(saveBoard(moved, target)).toEqual({ ok: true })
  })
  it('preserves an existing board and rejects an all-or-nothing append when its capacity cannot fit every module', () => {
    const target = file()
    const created = saveReadingSnapshot({ presentation: 'report', name: 'Existing', snapshot, includeChart: false }, target)
    if (!created.ok) throw Error(created.error)
    const initial = structuredClone(created.board)
    const appended = saveReadingSnapshot({ name: 'unused', snapshot, includeChart: false, target: { kind: 'existing', boardId: initial.id, expectedUpdatedAt: initial.updatedAt } }, target)
    if (!appended.ok) throw Error(appended.error)
    expect(appended.board.widgets[0]).toEqual(initial.widgets[0])
    const partial = { ...appended.board, widgets: [...appended.board.widgets, ...Array.from({ length: BOARD_LIMITS.maxWidgets - appended.board.widgets.length - 2 }, (_, i) => createWidget('note', 'Fixture', { x: 0, y: 100 + i * 3 }))] }
    expect(saveBoard(partial, target)).toEqual({ ok: true })
    const before = readFileSync(target, 'utf8'), actual = listBoards(target)[0]
    expect(saveReadingSnapshot({ name: 'unused', snapshot, includeChart: true, target: { kind: 'existing', boardId: actual.id, expectedUpdatedAt: actual.updatedAt } }, target)).toEqual({ ok: false, error: 'board-full' })
    expect(readFileSync(target, 'utf8')).toBe(before)
  })
})
