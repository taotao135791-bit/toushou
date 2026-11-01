import { createBoard, createWidget, findFreeSlot, WIDGET_DEFAULT_SIZES, BOARD_LIMITS } from '../shared/boards'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import type { KanbanBoard } from '../shared/types'
import { listBoards, saveBoard } from './boards'

export type SaveReadingSnapshotResult = { ok: true; board: KanbanBoard; widgetId: string } | { ok: false; error: string }

/** Persist one self-contained board in a single validated write. */
export function saveReadingSnapshot(raw: unknown, file?: string): SaveReadingSnapshotResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-input' }
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['name', 'snapshot', 'includeChart', 'language', 'target'].includes(key))) return { ok: false, error: 'invalid-input' }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const snapshot = validateReadingSnapshot(value.snapshot)
  if (!name || name.length > BOARD_LIMITS.maxNameLength || /[\x00-\x1f\x7f]/.test(name) || !snapshot || typeof value.includeChart !== 'boolean' || (value.language !== undefined && value.language !== 'zh' && value.language !== 'en')) return { ok: false, error: 'invalid-input' }
  let current: KanbanBoard | undefined
  if (value.target !== undefined) {
    if (!value.target || typeof value.target !== 'object' || Array.isArray(value.target)) return { ok: false, error: 'invalid-input' }
    const target = value.target as Record<string, unknown>
    if (Object.keys(target).some(key => !['kind', 'boardId', 'expectedUpdatedAt'].includes(key)) || target.kind !== 'existing' || typeof target.boardId !== 'string' || !target.boardId || target.boardId.length > BOARD_LIMITS.maxIdLength || /[\x00-\x1f\x7f]/.test(target.boardId) || !Number.isSafeInteger(target.expectedUpdatedAt) || (target.expectedUpdatedAt as number) < 0) return { ok: false, error: 'invalid-input' }
    let boards: KanbanBoard[]
    try { boards = listBoards(file) } catch { return { ok: false, error: 'board-store-unreadable' } }
    current = boards.find(board => board.id === target.boardId)
    if (!current) return { ok: false, error: 'not-found' }
    if (current.locked) return { ok: false, error: 'board-locked' }
    if (current.updatedAt !== target.expectedUpdatedAt || current.updatedAt >= Number.MAX_SAFE_INTEGER - 1) return { ok: false, error: 'conflict' }
    if (current.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'board-full' }
  }
  // Clone to keep caller-owned objects from changing the snapshot after save.
  const snapshotCopy = structuredClone(snapshot)
  const board = current ?? createBoard(name)
  const size = WIDGET_DEFAULT_SIZES['reading-snapshot']
  const slot = current ? findFreeSlot(current.widgets, size.w, size.h) : { x: 0, y: 0 }
  const widget = createWidget('reading-snapshot', value.language === 'en' ? 'Reading snapshot' : '读数快照', slot, { snapshot: snapshotCopy, includeChart: value.includeChart })
  const next = { ...board, widgets: [...board.widgets, widget], updatedAt: current ? Math.max(Date.now(), current.updatedAt + 1) : board.updatedAt }
  const saved = saveBoard(next, file, current ? current.updatedAt : null)
  return saved.ok ? { ok: true, board: next, widgetId: widget.id } : saved
}
