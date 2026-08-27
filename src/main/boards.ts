import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BoardNoteAppendResult, KanbanBoard } from '../shared/types'
import {
  BOARD_LIMITS,
  KanbanSaveResult,
  WIDGET_DEFAULT_SIZES,
  createWidget,
  findFreeSlot,
  migrateBoard,
  validateBoard
} from '../shared/boards'

/**
 * Widget board persistence — a single JSON document at
 * userData/kanban-boards.json, written atomically (tmp + rename, same as
 * writePiSettings). Deliberately NOT the generic store:set IPC: board data
 * crosses the trust boundary as `unknown` and is re-validated on every read
 * and write here. A missing file is an empty list, but a corrupt or unreadable
 * existing file is surfaced to the renderer and is never overwritten by a
 * later save. Reads also run
 * v1 kanban entries (columns/cards) through migrateBoard, so old files show
 * up as v2 widget boards and are written back as v2 on the next save.
 */

function defaultBoardsFile(): string {
  return path.join(app.getPath('userData'), 'kanban-boards.json')
}

function readBoards(file: string): KanbanBoard[] {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the local boards file.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The local boards file is not valid JSON.')
  }
  if (!Array.isArray(raw)) {
    throw new Error('The local boards file has an invalid format.')
  }
  const boards: KanbanBoard[] = []
  for (const entry of raw) {
    const board = migrateBoard(entry)
    if (board) boards.push(board)
  }
  return boards
}

function writeBoards(file: string, boards: KanbanBoard[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(boards, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function listBoards(file: string = defaultBoardsFile()): KanbanBoard[] {
  return readBoards(file)
}

/** Whole-board upsert, keyed by board id. Validates before touching disk. */
export function saveBoard(raw: unknown, file: string = defaultBoardsFile()): KanbanSaveResult {
  const board = validateBoard(raw, true)
  if (!board) return { ok: false, error: 'invalid-board' }
  let boards: KanbanBoard[]
  try {
    boards = readBoards(file)
  } catch {
    return { ok: false, error: 'board-store-unreadable' }
  }
  const index = boards.findIndex((b) => b.id === board.id)
  if (index === -1 && boards.length >= BOARD_LIMITS.maxBoards) {
    return { ok: false, error: 'board-limit' }
  }
  if (index === -1) boards.push(board)
  else boards[index] = board
  try {
    writeBoards(file, boards)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function deleteBoard(id: unknown, file: string = defaultBoardsFile()): KanbanSaveResult {
  if (typeof id !== 'string' || !id || id.length > BOARD_LIMITS.maxIdLength) {
    return { ok: false, error: 'invalid-board' }
  }
  let boards: KanbanBoard[]
  try {
    boards = readBoards(file)
  } catch {
    return { ok: false, error: 'board-store-unreadable' }
  }
  const next = boards.filter((b) => b.id !== id)
  // Deleting an absent board is an idempotent no-op — skip the write.
  if (next.length === boards.length) return { ok: true }
  try {
    writeBoards(file, next)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Atomically append an assistant reply as a note to the latest persisted
 * board. The renderer supplies only bounded text and an opaque board id; it
 * never round-trips a whole stale board document for this chat action.
 */
export function appendBoardNote(raw: unknown, file: string = defaultBoardsFile()): BoardNoteAppendResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-request' }
  const request = raw as Record<string, unknown>
  const boardId = request.boardId
  const title = request.title
  const text = request.text
  if (
    typeof boardId !== 'string' ||
    !boardId ||
    boardId.length > BOARD_LIMITS.maxIdLength ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > BOARD_LIMITS.maxWidgetTitleLength ||
    typeof text !== 'string' ||
    text.length > BOARD_LIMITS.maxNoteLength
  ) {
    return { ok: false, error: 'invalid-request' }
  }
  let boards: KanbanBoard[]
  try {
    boards = readBoards(file)
  } catch {
    return { ok: false, error: 'board-store-unreadable' }
  }
  const index = boards.findIndex((board) => board.id === boardId)
  if (index < 0) return { ok: false, error: 'not-found' }
  const current = boards[index]
  if (current.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'board-full' }
  const size = WIDGET_DEFAULT_SIZES.note
  const note = createWidget('note', title.trim(), findFreeSlot(current.widgets, size.w, size.h))
  note.config = { text }
  const next = { ...current, widgets: [...current.widgets, note], updatedAt: Date.now() }
  boards[index] = next
  try {
    writeBoards(file, boards)
    return { ok: true, board: next }
  } catch {
    return { ok: false, error: 'write-failed' }
  }
}
