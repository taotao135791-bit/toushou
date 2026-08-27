import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// boards.ts resolves its default store through electron's app.getPath; the
// tests mostly inject an explicit file, and the one default-path case reads
// userDataDir which beforeEach points at a fresh temp dir.
let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { appendBoardNote, deleteBoard, listBoards, saveBoard } from '../boards'
import { BOARD_LIMITS } from '../../shared/boards'
import { KanbanBoard } from '../../shared/types'

let dir: string
let file: string

function makeBoard(id: string, name = `Board ${id}`): KanbanBoard {
  return {
    id,
    name,
    widgets: [
      {
        id: `${id}-w1`,
        type: 'todo',
        title: 'Todo',
        layout: { x: 0, y: 0, w: 4, h: 6 },
        config: { items: [{ id: `${id}-i1`, text: 'Task', done: false }] }
      }
    ],
    createdAt: 1000,
    updatedAt: 2000
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-boards-'))
  userDataDir = dir
  file = path.join(dir, 'kanban-boards.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('listBoards', () => {
  it('returns an empty list when the file is missing', () => {
    expect(listBoards(file)).toEqual([])
  })

  it('surfaces corrupt JSON instead of silently treating it as an empty store', () => {
    writeFileSync(file, '{not json')
    expect(() => listBoards(file)).toThrow('The local boards file is not valid JSON.')
  })

  it('surfaces non-array JSON instead of silently treating it as an empty store', () => {
    writeFileSync(file, JSON.stringify({ boards: [] }))
    expect(() => listBoards(file)).toThrow('The local boards file has an invalid format.')
  })

  it('drops invalid entries but keeps the valid ones', () => {
    writeFileSync(
      file,
      JSON.stringify([makeBoard('good'), { id: 'bad' }, null, makeBoard('good-2')])
    )
    expect(listBoards(file).map((b) => b.id)).toEqual(['good', 'good-2'])
  })

  it('migrates v1 kanban files (columns/cards) into v2 widget boards on read', () => {
    const v1 = {
      id: 'legacy',
      name: 'Legacy board',
      template: 'task',
      columns: [
        {
          id: 'c1',
          title: 'boards.col.todo',
          cards: [{ id: 'k1', title: 'Write tests', note: 'unit first', createdAt: 1000 }]
        },
        { id: 'c2', title: 'boards.col.done', cards: [] }
      ],
      createdAt: 1000,
      updatedAt: 2000
    }
    writeFileSync(file, JSON.stringify([v1]))
    const boards = listBoards(file)
    expect(boards).toHaveLength(1)
    expect(boards[0].id).toBe('legacy')
    expect(boards[0].widgets).toEqual([
      {
        id: 'c1',
        type: 'todo',
        title: 'Todo',
        layout: { x: 0, y: 0, w: 4, h: 6 },
        config: { items: [{ id: 'k1', text: 'Write tests', done: false }] }
      },
      {
        id: 'c2',
        type: 'todo',
        title: 'Done',
        layout: { x: 4, y: 0, w: 4, h: 6 },
        config: { items: [] }
      }
    ])
    // Saving the migrated board writes the v2 shape back to disk.
    expect(saveBoard(boards[0], file)).toEqual({ ok: true })
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    expect(raw[0].widgets).toBeDefined()
    expect(raw[0].columns).toBeUndefined()
  })
})

describe('saveBoard', () => {
  it('refuses to overwrite a corrupt store', () => {
    writeFileSync(file, '{not json')
    const before = readFileSync(file, 'utf-8')
    expect(saveBoard(makeBoard('b1'), file)).toEqual({ ok: false, error: 'board-store-unreadable' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('round-trips a board through listBoards', () => {
    const board = makeBoard('b1')
    expect(saveBoard(board, file)).toEqual({ ok: true })
    expect(listBoards(file)).toEqual([board])
  })

  it('round-trips a board with no widgets (cleared board)', () => {
    const board = { ...makeBoard('empty'), widgets: [] }
    expect(saveBoard(board, file)).toEqual({ ok: true })
    expect(listBoards(file)).toEqual([board])
  })

  it('upserts by id instead of appending', () => {
    expect(saveBoard(makeBoard('b1'), file)).toEqual({ ok: true })
    const updated = { ...makeBoard('b1', 'Renamed'), updatedAt: 3000 }
    expect(saveBoard(updated, file)).toEqual({ ok: true })
    const boards = listBoards(file)
    expect(boards).toHaveLength(1)
    expect(boards[0].name).toBe('Renamed')
    expect(boards[0].updatedAt).toBe(3000)
  })

  it('rejects structurally invalid boards without touching the file', () => {
    expect(saveBoard(makeBoard('b1'), file)).toEqual({ ok: true })
    const before = readFileSync(file, 'utf-8')
    const result = saveBoard({ id: 'x' }, file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid-board')
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('rejects too many or malformed widgets instead of silently dropping them on save', () => {
    const valid = makeBoard('b1')
    expect(saveBoard(valid, file)).toEqual({ ok: true })
    const before = readFileSync(file, 'utf-8')
    const tooMany = {
      ...valid,
      widgets: Array.from({ length: BOARD_LIMITS.maxWidgets + 1 }, (_, index) => ({
        ...valid.widgets[0],
        id: `widget-${index}`
      }))
    }
    expect(saveBoard(tooMany, file)).toEqual({ ok: false, error: 'invalid-board' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('enforces the board limit for new boards but still allows upserts', () => {
    for (let i = 0; i < BOARD_LIMITS.maxBoards; i++) {
      expect(saveBoard(makeBoard(`b-${i}`), file)).toEqual({ ok: true })
    }
    const extra = saveBoard(makeBoard('one-too-many'), file)
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.error).toBe('board-limit')
    expect(saveBoard(makeBoard('b-0', 'Still fine'), file)).toEqual({ ok: true })
    expect(listBoards(file)).toHaveLength(BOARD_LIMITS.maxBoards)
  })

  it('writes to userData/kanban-boards.json by default', () => {
    expect(saveBoard(makeBoard('default-file'))).toEqual({ ok: true })
    const target = path.join(userDataDir, 'kanban-boards.json')
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf-8'))[0].id).toBe('default-file')
    expect(listBoards()).toHaveLength(1)
  })
})

describe('deleteBoard', () => {
  it('refuses to overwrite a corrupt store', () => {
    writeFileSync(file, '{not json')
    const before = readFileSync(file, 'utf-8')
    expect(deleteBoard('a', file)).toEqual({ ok: false, error: 'board-store-unreadable' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('removes the board and keeps the rest', () => {
    saveBoard(makeBoard('a'), file)
    saveBoard(makeBoard('b'), file)
    expect(deleteBoard('a', file)).toEqual({ ok: true })
    expect(listBoards(file).map((b) => b.id)).toEqual(['b'])
  })

  it('treats deleting an absent board as an idempotent no-op', () => {
    saveBoard(makeBoard('a'), file)
    const before = readFileSync(file, 'utf-8')
    expect(deleteBoard('absent', file)).toEqual({ ok: true })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('rejects non-string ids', () => {
    const result = deleteBoard(42, file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid-board')
  })
})

describe('appendBoardNote', () => {
  it('appends to the latest persisted board without replacing concurrent widgets', () => {
    const board = makeBoard('a')
    expect(saveBoard(board, file)).toEqual({ ok: true })
    const externallyUpdated = {
      ...board,
      widgets: [...board.widgets, { ...board.widgets[0], id: 'a-w2', title: 'Already here' }]
    }
    expect(saveBoard(externallyUpdated, file)).toEqual({ ok: true })
    const result = appendBoardNote({ boardId: 'a', title: 'Assistant summary', text: 'Latest reply' }, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.board.widgets.map((widget) => widget.title)).toEqual(['Todo', 'Already here', 'Assistant summary'])
    expect(listBoards(file)[0].widgets).toHaveLength(3)
  })

  it('rejects append when the current board is full without changing the file', () => {
    const board = makeBoard('a')
    board.widgets = Array.from({ length: BOARD_LIMITS.maxWidgets }, (_, index) => ({
      ...board.widgets[0],
      id: `widget-${index}`
    }))
    expect(saveBoard(board, file)).toEqual({ ok: true })
    const before = readFileSync(file, 'utf-8')
    expect(appendBoardNote({ boardId: 'a', title: 'Title', text: 'Reply' }, file)).toEqual({
      ok: false,
      error: 'board-full'
    })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })
})
