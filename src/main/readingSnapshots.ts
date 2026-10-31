import { createBoard, createWidget, BOARD_LIMITS } from '../shared/boards'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import type { KanbanBoard } from '../shared/types'
import { saveBoard } from './boards'

export type SaveReadingSnapshotResult = { ok: true; board: KanbanBoard } | { ok: false; error: string }

/** Persist one self-contained board in a single validated write. */
export function saveReadingSnapshot(raw: unknown, file?: string): SaveReadingSnapshotResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-input' }
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['name', 'snapshot', 'includeChart', 'language'].includes(key))) return { ok: false, error: 'invalid-input' }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const snapshot = validateReadingSnapshot(value.snapshot)
  if (!name || name.length > BOARD_LIMITS.maxNameLength || /[\x00-\x1f\x7f]/.test(name) || !snapshot || typeof value.includeChart !== 'boolean' || (value.language !== undefined && value.language !== 'zh' && value.language !== 'en')) return { ok: false, error: 'invalid-input' }
  // Clone to keep caller-owned objects from changing the snapshot after save.
  const snapshotCopy = structuredClone(snapshot)
  const board = createBoard(name)
  board.widgets = [createWidget('reading-snapshot', value.language === 'en' ? 'Reading snapshot' : '读数快照', { x: 0, y: 0 }, { snapshot: snapshotCopy, includeChart: value.includeChart })]
  const saved = file === undefined ? saveBoard(board) : saveBoard(board, file)
  return saved.ok ? { ok: true, board } : saved
}
