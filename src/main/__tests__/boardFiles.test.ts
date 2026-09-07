import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// boardFiles reads the board store through main/boards, whose default file
// resolves via electron's app.getPath; tests inject an explicit file.
let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { readBoardWidgetFile, stopBoardFileWatchers } from '../boardFiles'
import { saveBoard } from '../boards'
import { KanbanBoard } from '../../shared/types'

/** Minimal realpath-based stand-in for Main's FsGuard containment check. */
function makeGuard(root: string): (candidate: string) => boolean {
  // Canonicalize the root too (macOS /tmp -> /private/tmp style aliases).
  const canonicalRoot = realpathSync(path.resolve(root))
  return (candidate) => {
    let real: string
    try {
      real = realpathSync(path.resolve(candidate))
    } catch {
      return false
    }
    return real === canonicalRoot || real.startsWith(canonicalRoot + path.sep)
  }
}

let workspace: string
let outside: string
let file: string

function makeBoard(id: string, widgetConfig: Record<string, unknown>): KanbanBoard {
  return {
    id,
    name: `Board ${id}`,
    widgets: [
      {
        id: `${id}-w1`,
        type: 'file',
        title: 'Live file',
        layout: { x: 0, y: 0, w: 4, h: 4 },
        config: widgetConfig
      }
    ],
    createdAt: 1000,
    updatedAt: 2000
  }
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-boardfiles-'))
  userDataDir = dir
  file = path.join(dir, 'kanban-boards.json')
  workspace = path.join(dir, 'workspace')
  outside = path.join(dir, 'outside')
  mkdirSync(path.join(workspace, 'reports'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(workspace, 'reports', 'a.html'), '<p>live</p>')
  writeFileSync(path.join(workspace, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(path.join(outside, 'secret.png'), 'nope')
  stopBoardFileWatchers()
})

afterEach(() => {
  stopBoardFileWatchers()
  rmSync(userDataDir, { recursive: true, force: true })
})

const GUARD_FAIL = (): boolean => false

describe('readBoardWidgetFile', () => {
  it('rejects malformed selectors', () => {
    const params = {
      boardId: 'a',
      widgetId: 'a-w1',
      workspaceRealPath: workspace,
      isAllowed: GUARD_FAIL,
      file
    }
    for (const broken of [
      { ...params, boardId: '' },
      { ...params, widgetId: '' },
      { ...params, workspaceRealPath: '' }
    ]) {
      expect(readBoardWidgetFile(broken)).toEqual({ ok: false, error: 'invalid-request' })
    }
    expect(readBoardWidgetFile({ ...params, isAllowed: undefined as never })).toEqual({
      ok: false,
      error: 'invalid-request'
    })
  })

  it('answers not-found for missing boards, widgets or non-file widgets', () => {
    const note = makeBoard('b', { filePath: 'reports/a.html' })
    note.widgets[0].type = 'note'
    note.widgets[0].config = { text: 'hi' }
    expect(saveBoard(note, file)).toEqual({ ok: true })
    const params = { boardId: 'b', widgetId: 'b-w1', workspaceRealPath: workspace, isAllowed: GUARD_FAIL, file }
    expect(readBoardWidgetFile(params)).toEqual({ ok: false, error: 'not-found' })
    expect(readBoardWidgetFile({ ...params, widgetId: 'missing' })).toEqual({ ok: false, error: 'not-found' })
    expect(readBoardWidgetFile({ ...params, boardId: 'ghost' })).toEqual({ ok: false, error: 'not-found' })
  })

  it('answers no-file for an unbound file widget', () => {
    expect(saveBoard(makeBoard('a', {}), file)).toEqual({ ok: true })
    expect(
      readBoardWidgetFile({ boardId: 'a', widgetId: 'a-w1', workspaceRealPath: workspace, isAllowed: GUARD_FAIL, file })
    ).toEqual({ ok: false, error: 'no-file' })
  })

  it('reads HTML files as text inside the workspace', () => {
    expect(saveBoard(makeBoard('a', { filePath: 'reports/a.html' }), file)).toEqual({ ok: true })
    const result = readBoardWidgetFile({
      boardId: 'a',
      widgetId: 'a-w1',
      workspaceRealPath: workspace,
      isAllowed: makeGuard(workspace),
      file
    })
    expect(result).toMatchObject({ ok: true, kind: 'html', html: '<p>live</p>' })
  })

  it('reads images as data URLs', () => {
    expect(saveBoard(makeBoard('a', { filePath: 'chart.png' }), file)).toEqual({ ok: true })
    const result = readBoardWidgetFile({
      boardId: 'a',
      widgetId: 'a-w1',
      workspaceRealPath: workspace,
      isAllowed: makeGuard(workspace),
      file
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'image') return
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64')).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
  })

  it('refuses to persist a board whose file widget binds an unsafe path', () => {
    // Strict saves reject the WHOLE board rather than silently dropping the
    // widget — an unsafe bound path can never reach the store.
    expect(saveBoard(makeBoard('a', { filePath: '../../outside/secret.png' }), file)).toEqual({
      ok: false,
      error: 'invalid-board'
    })
    expect(
      readBoardWidgetFile({ boardId: 'a', widgetId: 'a-w1', workspaceRealPath: workspace, isAllowed: makeGuard(workspace), file })
    ).toEqual({ ok: false, error: 'not-found' })
  })

  it('denies a lexically-safe path whose real target escapes the workspace (symlink)', () => {
    const linked = makeBoard('l', { filePath: 'linked.png' })
    expect(saveBoard(linked, file)).toEqual({ ok: true })
    symlinkSync(path.join(outside, 'secret.png'), path.join(workspace, 'linked.png'))
    expect(
      readBoardWidgetFile({
        boardId: 'l',
        widgetId: 'l-w1',
        workspaceRealPath: workspace,
        isAllowed: makeGuard(workspace),
        file
      })
    ).toEqual({ ok: false, error: 'outside-workspace' })
  })

  it('denies reads when the guard rejects (nonexistent target or missing grant)', () => {
    expect(saveBoard(makeBoard('a', { filePath: 'gone/missing.html' }), file)).toEqual({ ok: true })
    // A missing target fails the realpath guard, same as Main's FsGuard.
    expect(
      readBoardWidgetFile({ boardId: 'a', widgetId: 'a-w1', workspaceRealPath: workspace, isAllowed: makeGuard(workspace), file })
    ).toEqual({ ok: false, error: 'outside-workspace' })
    expect(
      readBoardWidgetFile({ boardId: 'a', widgetId: 'a-w1', workspaceRealPath: workspace, isAllowed: GUARD_FAIL, file })
    ).toEqual({ ok: false, error: 'outside-workspace' })
  })

  it('reports read-failed for an unreadable target and too-large files', () => {
    expect(saveBoard(makeBoard('a', { filePath: 'reports/a.html' }), file)).toEqual({ ok: true })
    // The html file passes the guard, but is replaced by a directory before
    // the stat — surfacing the read-failed branch (not the guard).
    const target = path.join(workspace, 'reports', 'a.html')
    rmSync(target)
    mkdirSync(target)
    expect(
      readBoardWidgetFile({ boardId: 'a', widgetId: 'a-w1', workspaceRealPath: workspace, isAllowed: makeGuard(workspace), file })
    ).toEqual({ ok: false, error: 'read-failed' })
    rmSync(target, { recursive: true, force: true })
    writeFileSync(target, '<p>live</p>')

    const bigPath = path.join(workspace, 'big.png')
    writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 2))
    expect(saveBoard(makeBoard('b', { filePath: 'big.png' }), file)).toEqual({ ok: true })
    expect(
      readBoardWidgetFile({ boardId: 'b', widgetId: 'b-w1', workspaceRealPath: workspace, isAllowed: makeGuard(workspace), file })
    ).toEqual({ ok: false, error: 'too-large' })
  })

  it('fires onBound with the Main-only absolute path (never sent to the renderer)', () => {
    expect(saveBoard(makeBoard('a', { filePath: 'reports/a.html' }), file)).toEqual({ ok: true })
    const bound: Array<{ absolutePath: string; mtime: number }> = []
    const result = readBoardWidgetFile({
      boardId: 'a',
      widgetId: 'a-w1',
      workspaceRealPath: workspace,
      isAllowed: makeGuard(workspace),
      file,
      onBound: (info) => {
        bound.push(info)
      }
    })
    expect(result.ok).toBe(true)
    expect(bound).toHaveLength(1)
    expect(bound[0].absolutePath).toBe(path.join(workspace, 'reports', 'a.html'))
    // The renderer payload carries no absolute path.
    expect(JSON.stringify(result)).not.toContain(userDataDir)
  })

  it('reads back the persisted board exactly as saved (file widgets survive)', () => {
    const board = makeBoard('a', { filePath: 'reports/a.html' })
    expect(saveBoard(board, file)).toEqual({ ok: true })
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    expect(raw[0].widgets[0].type).toBe('file')
    expect(raw[0].widgets[0].config).toEqual({ filePath: 'reports/a.html' })
  })
})
