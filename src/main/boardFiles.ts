import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { isValidWidgetFilePath } from '../shared/boards'
import { BoardFileChange, BoardWidgetFileReadResult } from '../shared/types'
import { listBoards } from './boards'

/**
 * Live-file widgets (`type: 'file'`) — Main-side read + watch half.
 *
 * The board stores only a WORKSPACE-RELATIVE path. Every read resolves that
 * path against the ACTIVE workspace grant's canonical real path (never a
 * renderer-supplied one) and re-checks containment with fsGuard, so a saved
 * board can never make the app read outside an authorized root — the same
 * discipline as fs:read-file, just with the path coming from the persisted
 * board instead of the renderer. Images are returned as data URLs and HTML as
 * text; the renderer sandbox-renders HTML (allow-scripts, no same-origin).
 *
 * Watching reuses the board-design pattern: a lazy per-directory fs.watch
 * with a 300 ms debounce (coalesces editor save storms), broadcasting
 * boards:file-changed so the matching card reloads its content.
 */

/** Matches Main's image ceiling elsewhere (browser screenshots read similar). */
export const BOARD_FILE_WIDGET_MAX_BYTES = 10 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
}

export interface ReadBoardWidgetFileParams {
  boardId: string
  widgetId: string
  /** Canonical real path of the ACTIVE workspace grant (Main-owned). */
  workspaceRealPath: string
  /** fsGuard containment check injected by ipc.ts (realpath-based). */
  isAllowed: (absolutePath: string) => boolean
  /**
   * Main-side hook fired on success with the bound absolute path + mtime, so
   * ipc.ts can register the disk watcher WITHOUT that path ever reaching the
   * renderer payload.
   */
  onBound?: (bound: { absolutePath: string; mtime: number }) => void
  /** Test seam; production resolves the default boards store. */
  file?: string
}

/** Read the file bound to one file widget, resolving through the workspace. */
export function readBoardWidgetFile(params: ReadBoardWidgetFileParams): BoardWidgetFileReadResult {
  const { boardId, widgetId, workspaceRealPath, isAllowed } = params
  for (const value of [boardId, widgetId, workspaceRealPath]) {
    if (typeof value !== 'string' || !value) return { ok: false, error: 'invalid-request' }
  }
  if (typeof isAllowed !== 'function') return { ok: false, error: 'invalid-request' }
  const board = listBoards(params.file).find((entry) => entry.id === boardId)
  if (!board) return { ok: false, error: 'not-found' }
  const widget = board.widgets.find((entry) => entry.id === widgetId)
  if (!widget || widget.type !== 'file') return { ok: false, error: 'not-found' }
  const bound = widget.config.filePath
  if (typeof bound !== 'string' || !bound) return { ok: false, error: 'no-file' }
  if (!isValidWidgetFilePath(bound)) return { ok: false, error: 'unsupported-type' }

  const extension = (bound.split('.').pop() ?? '').toLowerCase()
  const isImage = extension in IMAGE_MIME_BY_EXT
  const isHtml = extension === 'html'
  if (!isImage && !isHtml) return { ok: false, error: 'unsupported-type' }

  // resolve + fsGuard: the real path (symlinks resolved) must stay inside an
  // authorized root; nonexistent paths and broken symlinks are denied too.
  const absolute = path.resolve(workspaceRealPath, bound)
  if (!isAllowed(absolute)) return { ok: false, error: 'outside-workspace' }
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return { ok: false, error: 'read-failed' }
  }
  if (!stat.isFile()) return { ok: false, error: 'read-failed' }
  if (stat.size > BOARD_FILE_WIDGET_MAX_BYTES) return { ok: false, error: 'too-large' }
  try {
    if (isImage) {
      const dataUrl = `data:${IMAGE_MIME_BY_EXT[extension]};base64,${readFileSync(absolute).toString('base64')}`
      params.onBound?.({ absolutePath: absolute, mtime: stat.mtimeMs })
      return { ok: true, kind: 'image', dataUrl, mtime: stat.mtimeMs }
    }
    params.onBound?.({ absolutePath: absolute, mtime: stat.mtimeMs })
    return { ok: true, kind: 'html', html: readFileSync(absolute, 'utf-8'), mtime: stat.mtimeMs }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
}

// ---------------------------------------------------------------------------
// Binding registry + watchers — one fs.watch per directory holding at least
// one bound file; a change fires boards:file-changed for every binding whose
// mtime actually moved. Bounded (oldest bindings evicted) because bindings
// refresh on every read.
// ---------------------------------------------------------------------------

const MAX_BINDINGS = 64

interface BoardFileBinding {
  boardId: string
  widgetId: string
  /** Canonical file path (same string the read used). */
  absolutePath: string
  mtime: number
}

export type BoardFileChangeListener = (change: BoardFileChange) => void

const bindings = new Map<string, BoardFileBinding>()
const watchers = new Map<string, { watcher: FSWatcher; debounce: ReturnType<typeof setTimeout> | null }>()
let listener: BoardFileChangeListener | null = null

function bindingKey(boardId: string, widgetId: string): string {
  return `${boardId}:${widgetId}`
}

/**
 * Remember (or refresh) the binding for one file widget and make sure its
 * directory is watched. Called after every successful read, so the registry
 * always mirrors what open boards are actually showing.
 */
export function registerBoardFileBinding(
  change: { boardId: string; widgetId: string; absolutePath: string; mtime: number },
  onChange: BoardFileChangeListener
): void {
  listener = onChange
  const key = bindingKey(change.boardId, change.widgetId)
  bindings.delete(key)
  while (bindings.size >= MAX_BINDINGS) {
    const oldest = bindings.keys().next().value
    if (oldest === undefined) break
    dropBinding(oldest)
  }
  bindings.set(key, { ...change })
  const directory = path.dirname(change.absolutePath)
  if (watchers.has(directory)) return
  try {
    const entry: { watcher: FSWatcher; debounce: ReturnType<typeof setTimeout> | null } = {
      watcher: watch(directory, () => scheduleDirectoryCheck(directory)),
      debounce: null
    }
    entry.watcher.on('error', () => closeWatch(directory))
    watchers.set(directory, entry)
  } catch {
    // Directory vanished or is unwatchable — the card simply won't auto-refresh.
  }
}

/** Drop every binding and close all watchers (used by tests and shutdown). */
export function stopBoardFileWatchers(): void {
  for (const key of [...bindings.keys()]) bindings.delete(key)
  for (const directory of [...watchers.keys()]) closeWatch(directory)
  listener = null
}

function dropBinding(key: string): void {
  const binding = bindings.get(key)
  bindings.delete(key)
  if (!binding) return
  const directory = path.dirname(binding.absolutePath)
  const stillNeeded = [...bindings.values()].some((b) => path.dirname(b.absolutePath) === directory)
  if (!stillNeeded) closeWatch(directory)
}

function closeWatch(directory: string): void {
  const entry = watchers.get(directory)
  watchers.delete(directory)
  if (!entry) return
  if (entry.debounce) clearTimeout(entry.debounce)
  try {
    entry.watcher.close()
  } catch {
    // Already closed.
  }
}

/** 300 ms debounce, same rationale as the board-design watcher. */
function scheduleDirectoryCheck(directory: string): void {
  const entry = watchers.get(directory)
  if (!entry) return
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.debounce = setTimeout(() => {
    entry.debounce = null
    checkDirectoryBindings(directory)
  }, 300)
}

function checkDirectoryBindings(directory: string): void {
  if (!listener) return
  for (const binding of bindings.values()) {
    if (path.dirname(binding.absolutePath) !== directory) continue
    let mtime = binding.mtime
    try {
      mtime = statSync(binding.absolutePath).mtimeMs
    } catch {
      continue // Deleted or transiently unreadable — keep the current content.
    }
    if (mtime === binding.mtime) continue
    binding.mtime = mtime
    listener({ boardId: binding.boardId, widgetId: binding.widgetId, mtime })
  }
}
