import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { saveReadingSnapshot } from '../readingSnapshots'
import { listBoards, saveBoard } from '../boards'
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
    const result = saveReadingSnapshot({ name: ' Test ', snapshot, includeChart: true }, target)
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
    expect(saveReadingSnapshot({ name: 'Test', snapshot, includeChart: false }, target)).toEqual({ ok: false, error: 'board-store-unreadable' })
    expect(readFileSync(target, 'utf8')).toBe('{broken')
  })
  it('rejects invalid dates, malformed metric values, and failures represented as zero', () => {
    const target = file()
    const badDate = structuredClone(snapshot); badDate.window.start = '2026-02-31'
    const badMetric = structuredClone(snapshot); badMetric.accounts[0].spend = Infinity
    const failedZero = structuredClone(snapshot); failedZero.accounts[1].spend = 0
    for (const bad of [badDate, badMetric, failedZero]) expect(saveReadingSnapshot({ name: 'Test', snapshot: bad, includeChart: false }, target)).toEqual({ ok: false, error: 'invalid-input' })
    expect(listBoards(target)).toEqual([])
  })
  it('blocks mutation of a saved reading but permits normal board edits', () => {
    const target = file(); const result = saveReadingSnapshot({ name: 'Test', snapshot, includeChart: false }, target)
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
