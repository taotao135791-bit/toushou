import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: { showSaveDialog: vi.fn() } }))
import { loadOrCreateHtmlBoard, saveHtmlBoard, exportHtmlBoard, removeHtmlBoardsForBoard, pruneHtmlBoardsForBoard, pruneOrphanedHtmlBoards, readHtmlBoardDocument, findHtmlBoardForReading } from './htmlBoards'
import { deleteBoard, listBoards, saveBoard } from './boards'
import { saveReadingSnapshot } from './readingSnapshots'
import type { ReadingSnapshot } from '../shared/readingSnapshot'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'Test', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 1000, accounts: [{ platform: 'tiktok', accountId: '999999999999999999', name: 'Private Account', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 900, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] }
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'html-board-test-')); dirs.push(dir)
  const boardFile = path.join(dir, 'boards.json'), file = path.join(dir, 'custom.json')
  const created = saveReadingSnapshot({ presentation: 'report', name: 'Private board', snapshot, includeChart: true }, boardFile)
  if (!created.ok) throw new Error('fixture failed')
  const board = created.board, widget = board.widgets[0]
  const deps = { file, boardFile, boards: () => listBoards(boardFile) }
  return { dir, file, board, widget, deps }
}

describe('local HTML board documents', () => {
  it('creates from a saved snapshot once, isolates caller objects and writes private storage', () => {
    const f = fixture()
    const first = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id, template: 'minimal' }, f.deps)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    first.document.snapshot.accounts[0].spend = 999
    const second = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.document.id).toBe(first.document.id)
    expect(second.document.snapshot.accounts[0].spend).toBe(10)
    if (process.platform !== 'win32') expect(statSync(f.file).mode & 0o777).toBe(0o600)
  })
  it('reads only validated documents for the main-process AI service', () => {
    const f = fixture(), opened = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    if (!opened.ok) throw Error('fixture failed')
    expect(readHtmlBoardDocument('bad\u0000id', f.deps)).toEqual({ ok: false, error: 'invalid-input' })
    const read = readHtmlBoardDocument(opened.document.id, f.deps)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    read.document.snapshot.accounts[0].spend = 999
    const again = readHtmlBoardDocument(opened.document.id, f.deps)
    if (!again.ok) throw Error('read failed')
    expect(again.document.snapshot.accounts[0].spend).toBe(10)
    writeFileSync(f.file, '{bad')
    expect(readHtmlBoardDocument(opened.document.id, f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
  })
  it('finds a saved customized board without creating one and verifies its source', () => {
    const f = fixture(), key = { boardId: f.board.id, widgetId: f.widget.id }
    expect(findHtmlBoardForReading(key, f.deps)).toEqual({ ok: false, error: 'not-found' })
    expect(() => statSync(f.file)).toThrow()
    const opened = loadOrCreateHtmlBoard(key, f.deps)
    if (!opened.ok) throw Error('fixture failed')
    const edited = saveHtmlBoard({ id: opened.document.id, expectedRevision: 1, html: '<p>Edited</p><div data-reading-slot></div>', css: '' }, f.deps)
    if (!edited.ok) throw Error('save failed')
    const found = findHtmlBoardForReading(key, f.deps)
    expect(found.ok).toBe(true)
    if (!found.ok) throw Error('find failed')
    expect(found.document.html).toContain('Edited')
    expect(found.document.revision).toBe(2)
    const changed = structuredClone(f.board)
    ;(changed.widgets[0].config.snapshot as ReadingSnapshot).accounts[0].spend = 999
    expect(findHtmlBoardForReading(key, { ...f.deps, boards: () => [changed] })).toEqual({ ok: false, error: 'conflict' })
    writeFileSync(f.deps.boardFile, '{bad')
    expect(findHtmlBoardForReading(key, f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
  })
  it('rejects stale edits, unsafe content and attempts to replace snapshot data', () => {
    const f = fixture(), opened = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    if (!opened.ok) throw Error('fixture failed')
    const doc = opened.document
    expect(saveHtmlBoard({ id: doc.id, expectedRevision: 2, html: doc.html, css: doc.css }, f.deps)).toEqual({ ok: false, error: 'conflict' })
    expect(saveHtmlBoard({ id: doc.id, expectedRevision: 1, html: '<script>x</script><div data-reading-slot></div>', css: doc.css }, f.deps)).toEqual({ ok: false, error: 'invalid-document' })
    expect(saveHtmlBoard({ id: doc.id, expectedRevision: 1, html: doc.html, css: doc.css, snapshot: {} }, f.deps)).toEqual({ ok: false, error: 'invalid-input' })
    expect(saveHtmlBoard({ id: doc.id, expectedRevision: 1, html: doc.html, css: doc.css, theme: 'untrusted' }, f.deps)).toEqual({ ok: false, error: 'invalid-input' })
    const saved = saveHtmlBoard({ id: doc.id, expectedRevision: 1, html: '<p>Edited</p><div data-reading-slot></div>', css: '.note { color: red; }', theme: 'operations' }, f.deps)
    expect(saved.ok).toBe(true)
    if (saved.ok) expect(saved.document).toMatchObject({ revision: 2, theme: 'operations', snapshot: { accounts: [{ spend: 10 }] } })
  })
  it('leaves tampered or unreadable storage intact', () => {
    const f = fixture(), opened = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    if (!opened.ok) throw Error('fixture failed')
    const data = JSON.parse(readFileSync(f.file, 'utf8')); data[0].snapshot.accounts[0].spend = 777
    const corrupt = JSON.stringify(data); writeFileSync(f.file, corrupt)
    expect(saveHtmlBoard({ id: opened.document.id, expectedRevision: 1, html: opened.document.html, css: opened.document.css }, f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
    expect(readFileSync(f.file, 'utf8')).toBe(corrupt)
  })
  it('exports only the saved revision and does not write after cancellation or a concurrent edit', async () => {
    const f = fixture(), opened = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    if (!opened.ok) throw Error('fixture failed')
    const doc = opened.document, target = path.join(f.dir, 'out.html')
    expect(await exportHtmlBoard({ id: doc.id, expectedRevision: 1 }, { ...f.deps, chooseFile: async () => ({ canceled: true }) })).toEqual({ ok: false, error: 'cancelled' })
    const conflict = await exportHtmlBoard({ id: doc.id, expectedRevision: 1 }, { ...f.deps, chooseFile: async () => {
      expect(saveHtmlBoard({ id: doc.id, expectedRevision: 1, html: doc.html, css: doc.css }, f.deps).ok).toBe(true)
      return { canceled: false, filePath: target }
    } })
    expect(conflict).toEqual({ ok: false, error: 'conflict' })
    expect(await exportHtmlBoard({ id: doc.id, expectedRevision: 2 }, { ...f.deps, chooseFile: async () => ({ canceled: false, filePath: target }) })).toEqual({ ok: true })
    const html = readFileSync(target, 'utf8')
    expect(html).toContain('账户 1')
    expect(html).not.toContain('Private Account')
    expect(html).not.toContain('999999999999999999')
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
  })
  it('removes only documents for a deleted board or removed snapshot widget', () => {
    const f = fixture(), boardFile = path.join(f.dir, 'boards.json')
    const second = saveReadingSnapshot({ presentation: 'report', name: 'Another', snapshot, includeChart: false }, boardFile)
    if (!second.ok) throw Error('fixture failed')
    const first = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    const other = loadOrCreateHtmlBoard({ boardId: second.board.id, widgetId: second.board.widgets[0].id }, f.deps)
    if (!first.ok || !other.ok) throw Error('fixture failed')
    expect(pruneHtmlBoardsForBoard({ boardId: f.board.id, retainedWidgetIds: [f.widget.id] }, f.deps)).toEqual({ ok: true, removed: 0 })
    expect(pruneHtmlBoardsForBoard({ boardId: f.board.id, retainedWidgetIds: [] }, f.deps)).toEqual({ ok: true, removed: 1 })
    expect(saveHtmlBoard({ id: first.document.id, expectedRevision: 1, html: first.document.html, css: first.document.css }, f.deps)).toEqual({ ok: false, error: 'not-found' })
    expect(removeHtmlBoardsForBoard(second.board.id, f.deps)).toEqual({ ok: true, removed: 1 })
    expect(removeHtmlBoardsForBoard(second.board.id, f.deps)).toEqual({ ok: true, removed: 0 })
    expect(pruneHtmlBoardsForBoard({ boardId: f.board.id, retainedWidgetIds: ['bad\u0000path'] }, f.deps)).toEqual({ ok: false, error: 'invalid-input' })
  })
  it('supports pre-existing non-ASCII source IDs allowed by the board schema', () => {
    const f = fixture()
    const board = structuredClone(f.board); board.id = '历史 看板'; board.widgets[0].id = '组件 甲'
    const deps = { ...f.deps, boards: () => [board] }
    const opened = loadOrCreateHtmlBoard({ boardId: board.id, widgetId: board.widgets[0].id }, deps)
    expect(opened.ok).toBe(true)
    expect(pruneHtmlBoardsForBoard({ boardId: board.id, retainedWidgetIds: [board.widgets[0].id] }, deps)).toEqual({ ok: true, removed: 0 })
    expect(removeHtmlBoardsForBoard(board.id, deps)).toEqual({ ok: true, removed: 1 })
  })
  it('does not overwrite unreadable storage when asked to remove a board', () => {
    const f = fixture(); writeFileSync(f.file, '{bad')
    expect(removeHtmlBoardsForBoard(f.board.id, f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
    expect(readFileSync(f.file, 'utf8')).toBe('{bad')
  })
  it('retries orphan cleanup without removing other boards or guessing when the source store is missing or corrupted', () => {
    const f = fixture(), boardFile = f.deps.boardFile
    const second = saveReadingSnapshot({ presentation: 'report', name: 'Another', snapshot, includeChart: false }, boardFile)
    if (!second.ok) throw Error('fixture failed')
    const first = loadOrCreateHtmlBoard({ boardId: f.board.id, widgetId: f.widget.id }, f.deps)
    const other = loadOrCreateHtmlBoard({ boardId: second.board.id, widgetId: second.board.widgets[0].id }, f.deps)
    if (!first.ok || !other.ok) throw Error('fixture failed')
    const original = readFileSync(f.file, 'utf8')
    const source = readFileSync(boardFile, 'utf8')
    writeFileSync(boardFile, '{bad')
    expect(pruneOrphanedHtmlBoards(f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
    expect(readFileSync(f.file, 'utf8')).toBe(original)
    unlinkSync(boardFile)
    expect(pruneOrphanedHtmlBoards(f.deps)).toEqual({ ok: false, error: 'store-unreadable' })
    expect(readFileSync(f.file, 'utf8')).toBe(original)
    writeFileSync(boardFile, source)
    expect(deleteBoard(f.board.id, boardFile)).toEqual({ ok: true })
    expect(pruneOrphanedHtmlBoards(f.deps)).toEqual({ ok: true, removed: 1 })
    const remaining = readFileSync(f.file, 'utf8')
    expect(remaining).not.toContain(first.document.id)
    expect(remaining).toContain(other.document.id)
  })
})


describe('compact module documents', () => {
  it('finds a deterministic module preview without writing, then persists edits and keeps its compact mode on export', async () => {
    const f = fixture()
    const modular = saveReadingSnapshot({ name: 'Modules', snapshot, includeChart: true }, f.deps.boardFile)
    if (!modular.ok) throw Error(modular.error)
    const key = { boardId: modular.board.id, widgetId: modular.focusWidgetId, language: 'en' as const }
    const found = findHtmlBoardForReading(key, f.deps)
    if (!found.ok) throw Error(found.error)
    expect(found.document.mode).toBe('module')
    expect(found.document.html).toContain('Spend')
    expect(() => statSync(f.file)).toThrow()
    const opened = loadOrCreateHtmlBoard(key, f.deps)
    if (!opened.ok) throw Error(opened.error)
    expect(opened.document.id).toBe(found.document.id)
    const { renderHtmlBoard } = await import('../shared/htmlBoard')
    const preview = renderHtmlBoard(opened.document, { anonymize: false, language: 'en' })
    expect(preview).toContain('10')
    expect(preview).toContain('Fixed snapshot')
    expect(preview).not.toContain('<table>')
    expect(preview).not.toContain('<script')
    expect(saveHtmlBoard({ id: opened.document.id, expectedRevision: 1, html: '<p>Revised</p><div data-reading-slot></div>', css: '' }, f.deps).ok).toBe(true)
    let exported = ''
    expect(await exportHtmlBoard({ id: opened.document.id, expectedRevision: 2, language: 'en' }, { ...f.deps, chooseFile: async () => ({ canceled: false, filePath: path.join(f.dir, 'module.html') }), writeExport: (_p, html) => { exported = html } })).toEqual({ ok: true })
    expect(exported).toContain('Revised')
    expect(exported).not.toContain('<table>')
    expect(exported).not.toContain('Private Account')
    expect(pruneOrphanedHtmlBoards(f.deps)).toEqual({ ok: true, removed: 0 })
    const removed = { ...modular.board, widgets: modular.board.widgets.filter(widget => widget.id !== modular.focusWidgetId) }
    expect(saveBoard(removed, f.deps.boardFile)).toEqual({ ok: true })
    expect(pruneOrphanedHtmlBoards(f.deps)).toEqual({ ok: true, removed: 1 })
  })
})
