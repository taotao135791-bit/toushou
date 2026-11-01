import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { htmlBoardTemplate, parseHtmlBoardTemplate, renderHtmlBoard, scopedHtmlBoardCss, validateHtmlBoardDocument, type HtmlBoardDocument, type HtmlBoardDocumentResult, type HtmlBoardExportResult, type HtmlBoardLanguage, type HtmlBoardTemplate } from '../shared/htmlBoard'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import { listBoards } from './boards'
import type { KanbanBoard } from '../shared/types'

const MAX_DOCUMENTS = 100
const MAX_FILE_BYTES = 10 * 1024 * 1024
interface Dependencies {
  file?: string
  boardFile?: string
  boards?: () => KanbanBoard[]
  chooseFile?: () => Promise<{ canceled: boolean; filePath?: string }>
  writeExport?: (filePath: string, html: string) => void | Promise<void>
}
const defaultFile = () => path.join(app.getPath('userData'), 'html-boards.json')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
// Source IDs follow the existing board schema; they are lookup keys, never paths.
const isSourceId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function readDocuments(file: string): HtmlBoardDocument[] {
  let text: string
  try {
    if (statSync(file).size > MAX_FILE_BYTES) throw new Error('file-too-large')
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw) || raw.length > MAX_DOCUMENTS) throw new Error('invalid-store')
  const documents = raw.map(validateHtmlBoardDocument)
  if (documents.some(document => !document || hash(document.snapshot) !== document.source.snapshotHash)) throw new Error('invalid-store')
  const valid = documents as HtmlBoardDocument[]
  if (new Set(valid.map(document => document.id)).size !== valid.length || new Set(valid.map(document => `${document.source.boardId}\0${document.source.widgetId}`)).size !== valid.length) throw new Error('invalid-store')
  return valid
}

function writePrivate(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* temp may not exist */ }
    throw error
  }
}
function writeDocuments(file: string, documents: HtmlBoardDocument[]): void {
  const content = JSON.stringify(documents)
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('file-too-large')
  writePrivate(file, content)
}

/** Main-only read for scoped services; never exposed as an arbitrary renderer read. */
export function readHtmlBoardDocument(id: unknown, deps: Dependencies = {}): HtmlBoardDocumentResult {
  if (!isId(id)) return { ok: false, error: 'invalid-input' }
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(deps.file ?? defaultFile()) } catch { return { ok: false, error: 'store-unreadable' } }
  const document = documents.find(item => item.id === id)
  return document ? { ok: true, document: structuredClone(document) } : { ok: false, error: 'not-found' }
}

/** Alias for Main callers; neither function is directly registered as IPC. */
export const readHtmlBoard = readHtmlBoardDocument

/** Read an existing customized document without creating one, bound to its saved source. */
export function findHtmlBoardForReading(raw: unknown, deps: Dependencies = {}): HtmlBoardDocumentResult {
  if (!record(raw) || !keys(raw, ['boardId', 'widgetId']) || !isSourceId(raw.boardId) || !isSourceId(raw.widgetId)) return { ok: false, error: 'invalid-input' }
  let boards: KanbanBoard[], documents: HtmlBoardDocument[]
  try { boards = (deps.boards ?? listBoards)(); documents = readDocuments(deps.file ?? defaultFile()) }
  catch { return { ok: false, error: 'store-unreadable' } }
  const widget = boards.find(board => board.id === raw.boardId)?.widgets.find(item => item.id === raw.widgetId && item.type === 'reading-snapshot')
  if (!widget) return { ok: false, error: 'not-found' }
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  if (!snapshot) return { ok: false, error: 'invalid-snapshot' }
  const document = documents.find(item => item.source.boardId === raw.boardId && item.source.widgetId === raw.widgetId)
  if (!document) return { ok: false, error: 'not-found' }
  if (document.source.snapshotHash !== hash(snapshot)) return { ok: false, error: 'conflict' }
  return { ok: true, document: structuredClone(document) }
}

/** Load an existing document or create one from a saved immutable reading snapshot. */
export function loadOrCreateHtmlBoard(raw: unknown, deps: Dependencies = {}): HtmlBoardDocumentResult {
  if (!record(raw) || !keys(raw, ['boardId', 'widgetId', 'template', 'language']) || !isSourceId(raw.boardId) || !isSourceId(raw.widgetId) || (raw.template !== undefined && (typeof raw.template !== 'string' || !['editorial', 'operations', 'minimal'].includes(raw.template))) || (raw.language !== undefined && raw.language !== 'zh' && raw.language !== 'en')) return { ok: false, error: 'invalid-input' }
  let boards: KanbanBoard[]
  try { boards = (deps.boards ?? listBoards)() } catch { return { ok: false, error: 'store-unreadable' } }
  const board = boards.find(item => item.id === raw.boardId)
  const widget = board?.widgets.find(item => item.id === raw.widgetId && item.type === 'reading-snapshot')
  if (!board || !widget) return { ok: false, error: 'not-found' }
  const snapshot = validateReadingSnapshot(widget.config.snapshot)
  if (!snapshot) return { ok: false, error: 'invalid-snapshot' }
  const file = deps.file ?? defaultFile()
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
  const existing = documents.find(item => item.source.boardId === raw.boardId && item.source.widgetId === raw.widgetId)
  if (existing) return existing.source.snapshotHash === hash(snapshot) ? { ok: true, document: structuredClone(existing) } : { ok: false, error: 'conflict' }
  if (documents.length >= MAX_DOCUMENTS) return { ok: false, error: 'limit' }
  const template = htmlBoardTemplate((raw.template ?? 'editorial') as HtmlBoardTemplate, (raw.language ?? 'zh') as HtmlBoardLanguage)
  const now = Date.now()
  const document: HtmlBoardDocument = {
    schemaVersion: 1, id: randomUUID(), revision: 1,
    source: { boardId: raw.boardId, widgetId: raw.widgetId, snapshotHash: hash(snapshot) },
    snapshot: structuredClone(snapshot), includeChart: widget.config.includeChart === true, theme: (raw.template ?? 'editorial') as HtmlBoardTemplate,
    html: template.html, css: template.css, createdAt: now, updatedAt: now
  }
  if (!validateHtmlBoardDocument(document)) return { ok: false, error: 'invalid-document' }
  try { writeDocuments(file, [...documents, document]); return { ok: true, document: structuredClone(document) } }
  catch { return { ok: false, error: 'write-failed' } }
}

/** Optimistic edit: snapshot, source, chart option, and creation time cannot be changed by the caller. */
export function saveHtmlBoard(raw: unknown, deps: Dependencies = {}): HtmlBoardDocumentResult {
  if (!record(raw) || !keys(raw, ['id', 'expectedRevision', 'html', 'css', 'theme']) || !isId(raw.id) || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1 || typeof raw.html !== 'string' || typeof raw.css !== 'string' || (raw.theme !== undefined && raw.theme !== 'editorial' && raw.theme !== 'operations' && raw.theme !== 'minimal')) return { ok: false, error: 'invalid-input' }
  try { parseHtmlBoardTemplate(raw.html); scopedHtmlBoardCss(raw.css) } catch { return { ok: false, error: 'invalid-document' } }
  const file = deps.file ?? defaultFile()
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
  const index = documents.findIndex(item => item.id === raw.id)
  if (index < 0) return { ok: false, error: 'not-found' }
  const previous = documents[index]
  if (previous.revision !== raw.expectedRevision) return { ok: false, error: 'conflict' }
  const document: HtmlBoardDocument = { ...previous, html: raw.html, css: raw.css, theme: (raw.theme ?? previous.theme ?? 'editorial') as HtmlBoardTemplate, revision: previous.revision + 1, updatedAt: Math.max(Date.now(), previous.updatedAt) }
  if (!validateHtmlBoardDocument(document)) return { ok: false, error: 'invalid-document' }
  const next = [...documents]; next[index] = document
  try { writeDocuments(file, next); return { ok: true, document: structuredClone(document) } }
  catch { return { ok: false, error: 'write-failed' } }
}

/** Only a saved revision is exported; a concurrent edit invalidates the pending save dialog. */
export async function exportHtmlBoard(raw: unknown, deps: Dependencies = {}): Promise<HtmlBoardExportResult> {
  if (!record(raw) || !keys(raw, ['id', 'expectedRevision', 'anonymize', 'language']) || !isId(raw.id) || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1 || (raw.anonymize !== undefined && typeof raw.anonymize !== 'boolean') || (raw.language !== undefined && raw.language !== 'zh' && raw.language !== 'en')) return { ok: false, error: 'invalid-input' }
  const file = deps.file ?? defaultFile()
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
  const document = documents.find(item => item.id === raw.id)
  if (!document) return { ok: false, error: 'not-found' }
  if (document.revision !== raw.expectedRevision) return { ok: false, error: 'conflict' }
  const language = raw.language === 'en' ? 'en' : 'zh'
  let html: string
  try { html = renderHtmlBoard(document, { anonymize: raw.anonymize !== false, language }) } catch { return { ok: false, error: 'invalid-document' } }
  try {
    const selection = await (deps.chooseFile ?? (() => dialog.showSaveDialog({ title: language === 'zh' ? '导出自定义读数看板' : 'Export custom reading board', defaultPath: 'custom-reading-board.html', filters: [{ name: 'HTML', extensions: ['html'] }] })))()
    if (selection.canceled || !selection.filePath) return { ok: false, error: 'cancelled' }
    try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
    if (documents.find(item => item.id === document.id)?.revision !== document.revision) return { ok: false, error: 'conflict' }
    await (deps.writeExport ?? writePrivate)(selection.filePath, html)
    return { ok: true }
  } catch { return { ok: false, error: 'write-failed' } }
}

export type HtmlBoardCleanupResult = { ok: true; removed: number } | { ok: false; error: 'invalid-input' | 'store-unreadable' | 'write-failed' }

/** Main-only helper. Caller must coordinate this with source-board deletion. */
export function removeHtmlBoardsForBoard(boardId: unknown, deps: Dependencies = {}): HtmlBoardCleanupResult {
  if (!isSourceId(boardId)) return { ok: false, error: 'invalid-input' }
  return pruneHtmlBoardsForBoard({ boardId, retainedWidgetIds: [] }, deps)
}

/** Main-only helper; pass widget IDs derived from the validated saved board, never raw renderer data. */
export function pruneHtmlBoardsForBoard(raw: unknown, deps: Dependencies = {}): HtmlBoardCleanupResult {
  if (!record(raw) || !keys(raw, ['boardId', 'retainedWidgetIds']) || !isSourceId(raw.boardId) || !Array.isArray(raw.retainedWidgetIds) || raw.retainedWidgetIds.length > 100 || !raw.retainedWidgetIds.every(isSourceId)) return { ok: false, error: 'invalid-input' }
  const retained = new Set(raw.retainedWidgetIds)
  const file = deps.file ?? defaultFile()
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
  const remaining = documents.filter(document => document.source.boardId !== raw.boardId || retained.has(document.source.widgetId))
  const removed = documents.length - remaining.length
  if (!removed) return { ok: true, removed: 0 }
  try { writeDocuments(file, remaining); return { ok: true, removed } }
  catch { return { ok: false, error: 'write-failed' } }
}

/**
 * Retry cleanup after a partially completed delete. Do not infer that a
 * missing or unreadable board store is an intentional deletion.
 */
export function pruneOrphanedHtmlBoards(deps: Dependencies = {}): HtmlBoardCleanupResult {
  const file = deps.file ?? defaultFile()
  let documents: HtmlBoardDocument[]
  try { documents = readDocuments(file) } catch { return { ok: false, error: 'store-unreadable' } }
  if (!documents.length) return { ok: true, removed: 0 }
  let boards: KanbanBoard[]
  try {
    boards = (deps.boards ?? listBoards)()
    const source = deps.boardFile ?? path.join(app.getPath('userData'), 'kanban-boards-v2.json')
    if (!statSync(source).isFile()) return { ok: false, error: 'store-unreadable' }
  } catch { return { ok: false, error: 'store-unreadable' } }
  const retained = new Map(boards.map(board => [board.id, new Set(board.widgets.filter(widget => widget.type === 'reading-snapshot').map(widget => widget.id))]))
  const remaining = documents.filter(document => retained.get(document.source.boardId)?.has(document.source.widgetId))
  const removed = documents.length - remaining.length
  if (!removed) return { ok: true, removed: 0 }
  try { writeDocuments(file, remaining); return { ok: true, removed } }
  catch { return { ok: false, error: 'write-failed' } }
}
