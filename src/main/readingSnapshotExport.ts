import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { KanbanBoard } from '../shared/types'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import { renderReadingSnapshotHtml } from '../shared/readingSnapshotHtml'
import { listBoards } from './boards'

export type ReadingSnapshotExportResult =
  | { ok: true }
  | { ok: false; error: 'invalid-input' | 'not-found' | 'invalid-snapshot' | 'board-store-unreadable' | 'cancelled' | 'write-failed' }

interface ExportDeps {
  listBoards?: () => KanbanBoard[]
  chooseFile?: () => Promise<{ canceled: boolean; filePath?: string }>
  writeHtml?: (filePath: string, html: string) => Promise<void>
}

/** Atomic replace ensures restrictive permissions even when the destination already exists. */
async function writePrivateHtml(filePath: string, html: string): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, filePath)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** Export only an already saved, validated snapshot. Never accept renderer-supplied HTML. */
export async function exportReadingSnapshot(raw: unknown, deps: ExportDeps = {}): Promise<ReadingSnapshotExportResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-input' }
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !['boardId', 'widgetId', 'anonymize', 'language'].includes(key)) ||
      typeof input.boardId !== 'string' || !input.boardId || input.boardId.length > 128 ||
      typeof input.widgetId !== 'string' || !input.widgetId || input.widgetId.length > 128 ||
      (input.anonymize !== undefined && typeof input.anonymize !== 'boolean') ||
      (input.language !== undefined && input.language !== 'zh' && input.language !== 'en')) return { ok: false, error: 'invalid-input' }
  let boards: KanbanBoard[]
  try { boards = (deps.listBoards ?? listBoards)() }
  catch { return { ok: false, error: 'board-store-unreadable' } }
  const board = boards.find(item => item.id === input.boardId)
  const widget = board?.widgets.find(item => item.id === input.widgetId && item.type === 'reading-snapshot')
  if (!board || !widget) return { ok: false, error: 'not-found' }
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  if (!snapshot) return { ok: false, error: 'invalid-snapshot' }
  const anonymize = input.anonymize !== false
  const language = input.language === 'en' ? 'en' : 'zh'
  const html = renderReadingSnapshotHtml(snapshot, { anonymize, language, title: board.name, includeChart: widget.config.includeChart === true })
  try {
    const selection = await (deps.chooseFile ?? (() => dialog.showSaveDialog({
      title: language === 'zh' ? '导出读数快照' : 'Export reading snapshot',
      defaultPath: 'reading-snapshot.html',
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })))()
    if (selection.canceled || !selection.filePath) return { ok: false, error: 'cancelled' }
    await (deps.writeHtml ?? writePrivateHtml)(selection.filePath, html)
    return { ok: true }
  } catch {
    return { ok: false, error: 'write-failed' }
  }
}
