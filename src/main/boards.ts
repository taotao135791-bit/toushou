import { app } from 'electron'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  BoardCardsApplyResult,
  BoardCardsCard,
  BoardNoteAppendResult,
  KanbanBoard
} from '../shared/types'
import {
  BOARD_LIMITS,
  KanbanSaveResult,
  WIDGET_DEFAULT_SIZES,
  createWidget,
  findFreeSlot,
  migrateBoard,
  validateBoard
} from '../shared/boards'
import { cardsToWidgets, parseBoardCardsProposal } from '../shared/boardCards'

/**
 * Widget board persistence — a single JSON document at
 * userData/kanban-boards-v2.json, written atomically (tmp + rename, same as
 * writePiSettings). Deliberately NOT the generic store:set IPC: board data
 * crosses the trust boundary as `unknown` and is re-validated on every read
 * and write here. A missing file is an empty list, but a corrupt or unreadable
 * existing file is surfaced to the renderer and is never overwritten by a
 * later save. Explicit test/import paths retain legacy recovery behavior.
 */

function defaultBoardsFile(): string {
  return path.join(app.getPath('userData'), 'kanban-boards-v2.json')
}

// Validation must not silently normalize away unknown metadata, even deeply
// nested in a widget config. Defaults added by validators are harmless.
function preservesInput(raw: unknown, validated: unknown): boolean {
  if (Array.isArray(raw)) {
    return Array.isArray(validated) && raw.length === validated.length && raw.every((item, i) => preservesInput(item, validated[i]))
  }
  if (raw !== null && typeof raw === 'object') {
    if (validated === null || typeof validated !== 'object' || Array.isArray(validated)) return false
    const output = validated as Record<string, unknown>
    return Object.entries(raw as Record<string, unknown>).every(([key, value]) =>
      value === undefined || (Object.prototype.hasOwnProperty.call(output, key) && preservesInput(value, output[key])))
  }
  return Object.is(raw, validated)
}

function migrateLegacyBoard(raw: Record<string, unknown>): KanbanBoard | null {
  const allowed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
  if (!allowed(raw, ['id', 'name', 'description', 'template', 'columns', 'createdAt', 'updatedAt']) ||
      (raw.template !== undefined && typeof raw.template !== 'string') ||
      !Array.isArray(raw.columns) || raw.columns.length > BOARD_LIMITS.maxWidgets) return null
  const used = new Set<string>()
  const stableId = (kind: string, index: string) => `legacy-${createHash('sha256').update(JSON.stringify([raw.id, kind, index])).digest('hex').slice(0, 32)}`
  const normalizeId = (id: unknown, kind: string, index: string): string | null => {
    const value = id === undefined ? stableId(kind, index) : id
    if (typeof value !== 'string' || !value || value.length > BOARD_LIMITS.maxIdLength || /[\x00-\x1f\x7f]/.test(value) || used.has(value)) return null
    used.add(value)
    return value
  }
  const notes: Array<{ title: string; text: string; index: string }> = []
  const columns: Array<Record<string, unknown>> = []
  for (const [ci, input] of raw.columns.entries()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const column = input as Record<string, unknown>
    if (!allowed(column, ['id', 'title', 'cards']) || typeof column.title !== 'string' ||
        !column.title || column.title.length > BOARD_LIMITS.maxWidgetTitleLength ||
        !Array.isArray(column.cards) || column.cards.length > BOARD_LIMITS.maxTodoItems) return null
    const columnId = normalizeId(column.id, 'column', String(ci))
    if (!columnId) return null
    const cards: Array<Record<string, unknown>> = []
    for (const [ki, inputCard] of column.cards.entries()) {
      if (!inputCard || typeof inputCard !== 'object' || Array.isArray(inputCard)) return null
      const card = inputCard as Record<string, unknown>
      if (!allowed(card, ['id', 'title', 'note', 'createdAt']) || typeof card.title !== 'string' ||
          !card.title.trim() || card.title.length > BOARD_LIMITS.maxTodoTextLength ||
          (card.note !== undefined && (typeof card.note !== 'string' || card.note.length > BOARD_LIMITS.maxNoteLength)) ||
          (card.createdAt !== undefined && (typeof card.createdAt !== 'number' || !Number.isFinite(card.createdAt) || card.createdAt < 0))) return null
      const index = `${ci}:${ki}`
      const id = normalizeId(card.id, 'card', index)
      if (!id) return null
      cards.push({ ...card, id })
      if (typeof card.note === 'string' && card.note.length) notes.push({ title: card.title, text: card.note, index })
    }
    columns.push({ ...column, id: columnId, cards })
  }
  const board = migrateBoard({ ...raw, columns })
  if (!board || board.widgets.length + notes.length > BOARD_LIMITS.maxWidgets) return null
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > BOARD_LIMITS.maxDescriptionLength) return null
    board.description = raw.description
  }
  for (const note of notes) {
    const id = normalizeId(undefined, 'note', note.index)
    if (!id) return null
    const size = WIDGET_DEFAULT_SIZES.note
    const widget = createWidget('note', note.title.slice(0, BOARD_LIMITS.maxWidgetTitleLength), findFreeSlot(board.widgets, size.w, size.h), { text: note.text })
    widget.id = id
    board.widgets.push(widget)
  }
  return validateBoard(board, true)
}

function validateStore(raw: unknown): KanbanBoard[] {
  let entries: unknown
  if (Array.isArray(raw)) entries = raw
  else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const envelope = raw as Record<string, unknown>
    if (envelope.schemaVersion !== 2 || Object.keys(envelope).some(key => key !== 'schemaVersion' && key !== 'boards')) {
      throw new Error('Unsupported or invalid boards file version; the original file was preserved.')
    }
    entries = envelope.boards
  }
  if (!Array.isArray(entries) || entries.length > BOARD_LIMITS.maxBoards) {
    throw new Error('The local boards file has an invalid format; the original file was preserved.')
  }
  const ids = new Set<string>()
  return entries.map(entry => {
    const legacy = entry !== null && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray((entry as Record<string, unknown>).columns)
    const board = legacy ? migrateLegacyBoard(entry as Record<string, unknown>) : validateBoard(entry, true)
    if (!board || !Number.isSafeInteger(board.updatedAt) || board.updatedAt >= Number.MAX_SAFE_INTEGER || (!legacy && !preservesInput(entry, board)) || ids.has(board.id)) {
      throw new Error('A board contains unsupported or invalid data; the original file was preserved.')
    }
    ids.add(board.id)
    return board
  })
}

function initializeDefaultStore(file: string): void {
  try {
    readFileSync(file)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const legacy = path.join(path.dirname(file), 'kanban-boards.json')
  let bytes: Buffer
  try {
    bytes = readFileSync(legacy)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Could not read the original boards file; it was preserved.')
  }
  try {
    const legacyData: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(legacyData)) throw new Error('The original boards file has an unsupported format; it was preserved.')
    validateStore(legacyData)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The original boards file is not valid JSON; it was preserved.')
    throw error
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.migration-${process.pid}-${randomUUID()}`
  const backupTmp = `${file}.backup-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' })
    // Keep backup and active store on independent inodes, including during
    // the initial raw-array phase, so in-place edits cannot change both.
    writeFileSync(backupTmp, bytes, { mode: 0o600, flag: 'wx' })
    const backup = path.join(path.dirname(file), 'kanban-boards-pre-v2-backup.json')
    try {
      linkSync(backupTmp, backup)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Never overwrite an existing backup or silently trust unrelated bytes.
      if (!readFileSync(backup).equals(bytes)) throw new Error('The existing board migration backup differs; all files were preserved.')
    }
    try {
      // A competing initializer must never replace an already-created store.
      linkSync(tmp, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    try { rmSync(backupTmp, { force: true }) } catch { /* best effort */ }
  }
}

function readBoards(file: string): KanbanBoard[] {
  const isolated = file === defaultBoardsFile()
  if (isolated) initializeDefaultStore(file)
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
  if (isolated) return validateStore(raw)
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
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    // Create a fresh private file: a leftover temp file must not cause a
    // brief write to a more permissive path containing account metrics.
    const payload = file === defaultBoardsFile() ? { schemaVersion: 2, boards } : boards
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* best effort after failure */ }
  }
}

export function listBoards(file: string = defaultBoardsFile()): KanbanBoard[] {
  return readBoards(file)
}

/**
 * Persist a new tab order (drag-to-reorder). The id set must match the store
 * exactly — no additions, no drops — so a stale drag can never delete or
 * resurrect boards; only the order changes.
 */
export function reorderBoards(ids: unknown, file: string = defaultBoardsFile()): KanbanSaveResult {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === 'string')) {
    return { ok: false, error: 'invalid-order' }
  }
  let boards: KanbanBoard[]
  try {
    boards = readBoards(file)
  } catch {
    return { ok: false, error: 'board-store-unreadable' }
  }
  const current = new Set(boards.map((b) => b.id))
  const incoming = new Set(ids)
  // Duplicate ids ([a, a, b]) would persist a duplicated tab: the length
  // check catches it because the Set collapses duplicates.
  if (incoming.size !== ids.length || current.size !== incoming.size || [...current].some((id) => !incoming.has(id))) {
    return { ok: false, error: 'order-mismatch' }
  }
  const byId = new Map(boards.map((b) => [b.id, b]))
  try {
    writeBoards(file, ids.map((id) => byId.get(id)!))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Whole-board upsert, keyed by board id. Validates before touching disk. */
export function saveBoard(raw: unknown, file: string = defaultBoardsFile(), expectedUpdatedAt?: number | null): KanbanSaveResult {
  const board = validateBoard(raw, true)
  if (!board || !Number.isSafeInteger(board.updatedAt) || board.updatedAt >= Number.MAX_SAFE_INTEGER || (file === defaultBoardsFile() && !preservesInput(raw, board))) return { ok: false, error: 'invalid-board' }
  let boards: KanbanBoard[]
  try {
    boards = readBoards(file)
  } catch {
    return { ok: false, error: 'board-store-unreadable' }
  }
  const index = boards.findIndex((b) => b.id === board.id)
  if (expectedUpdatedAt === null && index !== -1) return { ok: false, error: 'conflict' }
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null &&
      (!Number.isSafeInteger(expectedUpdatedAt) || index === -1 || boards[index].updatedAt !== expectedUpdatedAt || board.updatedAt <= expectedUpdatedAt)) {
    return { ok: false, error: 'conflict' }
  }
  if (index !== -1) {
    if (!Number.isSafeInteger(boards[index].updatedAt) || boards[index].updatedAt >= Number.MAX_SAFE_INTEGER - 1) return { ok: false, error: 'conflict' }
    // Main-owned legacy callers may submit the old timestamp. Preserve their
    // behavior while ensuring every mutation invalidates stale UI proposals.
    board.updatedAt = Math.max(board.updatedAt, boards[index].updatedAt + 1)
    for (const previous of boards[index].widgets) {
      if (previous.type !== 'reading-snapshot') continue
      const next = board.widgets.find(widget => widget.id === previous.id)
      // Removing a widget is allowed; silently rewriting a saved reading is not.
      if (next && (next.type !== 'reading-snapshot' || !isDeepStrictEqual(previous.config.snapshot, next.config.snapshot))) {
        return { ok: false, error: 'snapshot-immutable' }
      }
    }
  }
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
  // Locked boards refuse deletion here too — the tab lock must hold even
  // for callers that skip the renderer's confirm dialog.
  if (boards.some((b) => b.id === id && b.locked === true)) {
    return { ok: false, error: 'board-locked' }
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
  if (!Number.isSafeInteger(current.updatedAt) || current.updatedAt >= Number.MAX_SAFE_INTEGER - 1) return { ok: false, error: 'write-failed' }
  const next = { ...current, widgets: [...current.widgets, note], updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  boards[index] = next
  try {
    writeBoards(file, boards)
    return { ok: true, board: next }
  } catch {
    return { ok: false, error: 'write-failed' }
  }
}

export interface ApplyBoardCardsOptions {
  file?: string
  /**
   * Main-only workspace authority, injected by ipc.ts: resolves a proposed
   * file-card path against the ACTIVE workspace grant named in the request
   * and returns its canonical workspace-relative form, or null when the path
   * is outside that grant (or the grant is gone). Injected as a closure so
   * this module stays fs-free and unit-testable.
   */
  resolveWorkspaceFile?: (filePath: string) => string | null
}

/**
 * Apply a ```board-cards proposal to ONE board — the data-card sibling of
 * appendBoardNote. The renderer sends the RAW fence text plus an opaque board
 * id; Main re-parses and re-validates everything (renderer structures are
 * never trusted), re-reads the latest board before writing so a stale chat
 * card cannot clobber recent edits, and lands the cards through the same
 * widget factories/save path as a hand edit. Nothing is written unless the
 * whole operation validates.
 */
export function applyBoardCards(raw: unknown, opts: ApplyBoardCardsOptions = {}): BoardCardsApplyResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid-request', issues: [] }
  }
  const request = raw as Record<string, unknown>
  const boardId = request.boardId
  const proposalRaw = request.raw
  if (
    typeof boardId !== 'string' ||
    !boardId ||
    boardId.length > BOARD_LIMITS.maxIdLength ||
    typeof proposalRaw !== 'string'
  ) {
    return { ok: false, error: 'invalid-request', issues: [] }
  }
  // Re-parse the raw proposal — the SAME validator the preview used.
  const parsed = parseBoardCardsProposal(proposalRaw)
  if (!parsed.ok) return { ok: false, error: 'invalid-proposal', issues: parsed.issues }
  const issues = [...parsed.issues]

  // File cards need an authorized workspace: resolve each path against the
  // grant now and store only the canonical relative form. Out-of-workspace
  // cards are skipped with a warning; the apply fails only if nothing valid
  // remains.
  let cards: BoardCardsCard[] = parsed.proposal.cards
  if (cards.some((card) => card.type === 'file')) {
    const resolve = opts.resolveWorkspaceFile
    if (!resolve) return { ok: false, error: 'no-workspace', issues }
    const kept: BoardCardsCard[] = []
    cards.forEach((card, index) => {
      if (card.type !== 'file') {
        kept.push(card)
        return
      }
      const relative = resolve(card.filePath)
      if (!relative) {
        issues.push({
          level: 'warning',
          card: index,
          message: `File "${card.filePath.slice(0, 80)}" is outside the authorized workspace; card skipped.`
        })
        return
      }
      kept.push({ ...card, filePath: relative })
    })
    if (kept.length === 0) {
      return { ok: false, error: 'invalid-proposal', issues: [...issues, { level: 'error', card: null, message: 'No valid cards in this proposal.' }] }
    }
    cards = kept
  }

  let boards: KanbanBoard[]
  try {
    boards = readBoards(opts.file ?? defaultBoardsFile())
  } catch {
    return { ok: false, error: 'board-store-unreadable', issues }
  }
  const index = boards.findIndex((board) => board.id === boardId)
  if (index < 0) return { ok: false, error: 'not-found', issues }
  const current = boards[index]
  const widgets = cardsToWidgets({ version: 1, cards }, current.widgets)
  if (current.widgets.length + widgets.length > BOARD_LIMITS.maxWidgets) {
    return { ok: false, error: 'board-full', issues }
  }
  if (!Number.isSafeInteger(current.updatedAt) || current.updatedAt >= Number.MAX_SAFE_INTEGER - 1) return { ok: false, error: 'write-failed', issues }
  const next: KanbanBoard = { ...current, widgets: [...current.widgets, ...widgets], updatedAt: Math.max(Date.now(), current.updatedAt + 1) }
  boards[index] = next
  try {
    writeBoards(opts.file ?? defaultBoardsFile(), boards)
    return {
      ok: true,
      board: next,
      widgetIds: widgets.map((widget) => widget.id),
      issues
    }
  } catch {
    return { ok: false, error: 'write-failed', issues }
  }
}
