import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, dialog: { showSaveDialog: vi.fn() } }))
import { exportReadingSnapshot } from './readingSnapshotExport'
import { saveReadingSnapshot } from './readingSnapshots'
import { listBoards } from './boards'
import type { ReadingSnapshot } from '../shared/readingSnapshot'

const dirs: string[] = []
function temp() { const dir = mkdtempSync(path.join(os.tmpdir(), 'snapshot-export-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'Private Range', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 2000, accounts: [
  { platform: 'tiktok', accountId: '999999999999999999', name: 'Private Name', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 1000, timezone: null, currency: 'USD', spend: 7, previousSpend: null, impressions: 100, clicks: 5, conversions: 1 }
] }

describe('export saved reading snapshot', () => {
  it('loads the saved widget and writes an anonymous private file by default', async () => {
    const dir = temp(), boardFile = path.join(dir, 'boards.json'), target = path.join(dir, 'out.html')
    const created = saveReadingSnapshot({ name: 'Private board', snapshot, includeChart: true }, boardFile)
    if (!created.ok) throw new Error('fixture failed')
    const result = await exportReadingSnapshot({ boardId: created.board.id, widgetId: created.board.widgets[0].id }, { listBoards: () => listBoards(boardFile), chooseFile: async () => ({ canceled: false, filePath: target }) })
    expect(result).toEqual({ ok: true })
    const html = readFileSync(target, 'utf8')
    expect(html).toContain('账户 1')
    expect(html).toContain('class="bar"')
    for (const text of ['Private board', 'Private Name', 'Private Range', '999999999999999999']) expect(html).not.toContain(text)
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('allows an explicitly identified export and does not accept renderer-provided content', async () => {
    const dir = temp(), boardFile = path.join(dir, 'boards.json'), target = path.join(dir, 'out.html')
    const created = saveReadingSnapshot({ name: 'Example board', snapshot, includeChart: false }, boardFile)
    if (!created.ok) throw new Error('fixture failed')
    const base = { boardId: created.board.id, widgetId: created.board.widgets[0].id }
    const deps = { listBoards: () => listBoards(boardFile), chooseFile: async () => ({ canceled: false, filePath: target }) }
    expect(await exportReadingSnapshot({ ...base, html: '<script>x</script>' }, deps)).toEqual({ ok: false, error: 'invalid-input' })
    expect(await exportReadingSnapshot({ ...base, anonymize: false }, deps)).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toContain('Private Name')
    expect(readFileSync(target, 'utf8')).not.toContain('class="bar"')
  })

  it('does not write on cancellation or missing saved widget', async () => {
    const dir = temp(), boardFile = path.join(dir, 'boards.json')
    const created = saveReadingSnapshot({ name: 'Example', snapshot, includeChart: true }, boardFile)
    if (!created.ok) throw new Error('fixture failed')
    const write = vi.fn(async () => {})
    const choose = vi.fn(async () => ({ canceled: true }))
    const deps = { listBoards: () => listBoards(boardFile), chooseFile: choose, writeHtml: write }
    expect(await exportReadingSnapshot({ boardId: created.board.id, widgetId: created.board.widgets[0].id }, deps)).toEqual({ ok: false, error: 'cancelled' })
    expect(write).not.toHaveBeenCalled()
    choose.mockClear()
    expect(await exportReadingSnapshot({ boardId: created.board.id, widgetId: 'missing' }, deps)).toEqual({ ok: false, error: 'not-found' })
    expect(choose).not.toHaveBeenCalled()
    expect(await exportReadingSnapshot({ boardId: 'x', widgetId: 'y', anonymize: 'false' }, deps)).toEqual({ ok: false, error: 'invalid-input' })
  })

  it('surfaces unreadable board storage and failed writes without leaking error details', async () => {
    expect(await exportReadingSnapshot({ boardId: 'x', widgetId: 'y' }, { listBoards: () => { throw Error('private path') } })).toEqual({ ok: false, error: 'board-store-unreadable' })
    const dir = temp(), boardFile = path.join(dir, 'boards.json')
    const created = saveReadingSnapshot({ name: 'Example', snapshot, includeChart: true }, boardFile)
    if (!created.ok) throw new Error('fixture failed')
    const result = await exportReadingSnapshot({ boardId: created.board.id, widgetId: created.board.widgets[0].id }, { listBoards: () => listBoards(boardFile), chooseFile: async () => ({ canceled: false, filePath: '/not-used' }), writeHtml: async () => { throw Error('private path') } })
    expect(result).toEqual({ ok: false, error: 'write-failed' })
  })
})
