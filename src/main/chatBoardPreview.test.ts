import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBoard, createWidget } from '../shared/boards'
import { getChatBoardPreview, staticFilePreview } from './chatBoardPreview'
import { saveReadingSnapshot } from './readingSnapshots'
import { listBoards } from './boards'
import { findHtmlBoardForReading } from './htmlBoards'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('chat board preview', () => {
  it('rebuilds HTML without executable, network, form, SVG, or event content and retains safe text and styling', () => {
    const html = staticFilePreview('<html><head><style>.card {color: red; background:url(https://bad.invalid/x); padding: 12px} @import "https://bad.invalid/x";</style></head><body><div class="card" style="font-weight:700; background:url(https://bad.invalid/y)" onclick="bad()">Readable<script>alert(1)</script><img src="https://bad.invalid/x"><svg><script>bad()</script></svg><form><button>Send</button></form><iframe src="https://bad.invalid"></iframe></div></body></html>')!
    expect(html).toContain('Readable')
    expect(html).toContain('color:red')
    expect(html).toContain('padding:12px')
    expect(html).toContain('font-weight:700')
    expect(html).not.toMatch(/<script|<img|<svg|<iframe|<form|onclick|bad\.invalid|url\(/i)
    expect(html).toContain("default-src 'none'")
  })

  it('requires a live session, workspace authorization, existing board and exact saved widget', () => {
    const board = createBoard('Synthetic')
    const widget = createWidget('file', 'File', { x: 0, y: 0 }, { filePath: 'page.html' })
    board.widgets.push(widget)
    const input = { sessionId: 'session', boardId: board.id, widgetId: widget.id }
    const deps = { access: () => ({ cwd: '/synthetic' }), authorized: () => true, boards: () => [board], readFile: () => ({ name: 'page.html', bytes: Buffer.from('<p>safe</p>') }) }
    expect(getChatBoardPreview(input, { ...deps, access: () => null })).toEqual({ ok: false, error: 'unauthorized' })
    expect(getChatBoardPreview(input, { ...deps, authorized: () => false })).toEqual({ ok: false, error: 'unauthorized' })
    expect(getChatBoardPreview({ ...input, widgetId: 'missing' }, deps)).toEqual({ ok: false, error: 'not-found' })
    expect(getChatBoardPreview({ ...input, path: 'other.html' }, deps)).toEqual({ ok: false, error: 'invalid-input' })
    expect(getChatBoardPreview(input, deps)).toMatchObject({ ok: true, source: 'file', boardName: 'Synthetic' })
  })

  it('does not follow a file widget symlink outside its authorized workspace', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'chat-preview-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'chat-preview-outside-'))
    try {
      writeFileSync(path.join(outside, 'target.html'), '<p>private</p>')
      try { symlinkSync(path.join(outside, 'target.html'), path.join(workspace, 'escape.html')) } catch { return }
      const board = createBoard('Synthetic')
      const widget = createWidget('file', 'File', { x: 0, y: 0 }, { filePath: 'escape.html' })
      board.widgets.push(widget)
      expect(getChatBoardPreview({ sessionId: 's', boardId: board.id, widgetId: widget.id }, { access: () => ({ cwd: workspace }), authorized: () => true, boards: () => [board] })).toEqual({ ok: false, error: 'unavailable' })
    } finally { rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
  })

  it('renders saved snapshot and module sources locally without creating a document', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chat-snapshot-'))
    try {
      const file = path.join(dir, 'boards.json')
      const snapshot = { kind: 'reading-snapshot' as const, version: 1 as const, rangeLabel: 'Synthetic', window: { start: '2026-01-01', end: '2026-01-01' }, capturedAt: 100,
        accounts: [{ platform: 'tiktok' as const, accountId: 'synthetic', name: 'Synthetic', status: 'ok' as const, statusDetail: null, window: { start: '2026-01-01', end: '2026-01-01' }, previousWindow: null, sourceAt: 90, timezone: 'UTC', currency: 'USD', spend: 42, previousSpend: null, impressions: 10, clicks: 1, conversions: 1 }] }
      const saved = saveReadingSnapshot({ name: 'Synthetic', snapshot, includeChart: false }, file)
      if (!saved.ok) throw new Error(saved.error)
      const snapshotWidget = saved.board.widgets.find(widget => widget.type === 'reading-snapshot')!
      const docFile = path.join(dir, 'documents.json')
      const deps = { access: () => ({ cwd: dir }), authorized: () => true, boards: () => listBoards(file), find: (input: unknown) => findHtmlBoardForReading(input, { file: docFile, boards: () => listBoards(file) }) }
      const result = getChatBoardPreview({ sessionId: 's', boardId: saved.board.id, widgetId: snapshotWidget.id }, deps)
      expect(result).toMatchObject({ ok: true, source: 'snapshot' })
      if (result.ok) expect(result.html).toContain('42')
      const module = saved.board.widgets.find(widget => widget.type === 'reading-module')!
      const moduleResult = getChatBoardPreview({ sessionId: 's', boardId: saved.board.id, widgetId: module.id }, deps)
      expect(moduleResult).toMatchObject({ ok: true, source: 'module' })
      if (moduleResult.ok) expect(moduleResult.html).toContain('42')
      expect(existsSync(docFile)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
