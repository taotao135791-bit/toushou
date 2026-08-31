import { app, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { BoardDesignChange, BoardDesignDocument, BoardDesignSaveResult } from '../shared/types'
import {
  BOARD_DESIGN_MAX_BYTES,
  DEFAULT_BOARD_DESIGN_MARKDOWN,
  parseBoardDesign
} from '../shared/boardDesign'

/**
 * Board design persistence — a single markdown document at
 * userData/board-design.md, written atomically (tmp + rename, same as the
 * boards store). It carries appearance DEFAULTS only; persisted boards keep
 * their own per-widget/per-board overrides and are never rewritten here.
 * Both input paths (the in-app dialog and the chat "apply" action) funnel
 * through saveBoardDesign, which refuses to write a document with parse
 * errors. A lazy fs.watch rebroadcasts external edits so open boards follow
 * the file; saves made here are echoed to subscribers directly and the
 * resulting self-triggered watch event is skipped.
 */

export function boardDesignFile(): string {
  return path.join(app.getPath('userData'), 'board-design.md')
}

/** A missing file means "no custom design": return the template, unpersisted. */
export function readBoardDesign(file: string = boardDesignFile()): BoardDesignDocument {
  let markdown: string
  try {
    markdown = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      markdown = DEFAULT_BOARD_DESIGN_MARKDOWN
    } else {
      throw new Error('Could not read the board design file.')
    }
  }
  const { spec, issues } = parseBoardDesign(markdown)
  return { path: file, markdown, spec, issues }
}

export function saveBoardDesign(raw: unknown, file: string = boardDesignFile()): BoardDesignSaveResult {
  if (typeof raw !== 'string' || raw.length > BOARD_DESIGN_MAX_BYTES) {
    return { ok: false, error: 'invalid-request', issues: [] }
  }
  const { spec, issues } = parseBoardDesign(raw)
  if (issues.some((i) => i.level === 'error')) {
    return { ok: false, error: 'invalid-design', issues }
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, raw, 'utf-8')
    renameSync(tmp, file)
    // Skip the watch event our own atomic write is about to produce; the
    // saving renderer already gets this spec in the IPC response/broadcast.
    selfWriteContent = raw
    return { ok: true, spec, issues }
  } catch {
    return { ok: false, error: 'write-failed', issues }
  }
}

/** Reveal the design file, writing the template first when it does not exist. */
export function revealBoardDesign(file: string = boardDesignFile()): boolean {
  if (!existsSync(file)) {
    const result = saveBoardDesign(DEFAULT_BOARD_DESIGN_MARKDOWN, file)
    if (!result.ok) return false
  }
  shell.showItemInFolder(file)
  return true
}

// ---------------------------------------------------------------------------
// File watching — lazy, single watcher per file; 300 ms debounce coalesces
// the tmp-write + rename pair and rapid editor saves.
// ---------------------------------------------------------------------------

let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let selfWriteContent: string | null = null

export function watchBoardDesign(
  onChange: (change: BoardDesignChange) => void,
  file: string = boardDesignFile()
): void {
  stopBoardDesignWatch()
  const directory = path.dirname(file)
  const basename = path.basename(file)
  try {
    mkdirSync(directory, { recursive: true })
    watcher = watch(directory, (_event, name) => {
      if (name && name.toString() !== basename) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        let markdown: string
        try {
          markdown = readFileSync(file, 'utf-8')
        } catch {
          // Deleted or temporarily unreadable — leave the current design alone.
          return
        }
        if (selfWriteContent !== null && markdown === selfWriteContent) {
          selfWriteContent = null
          return
        }
        selfWriteContent = null
        onChange(parseBoardDesign(markdown))
      }, 300)
    })
    watcher.on('error', () => {
      stopBoardDesignWatch()
    })
  } catch {
    watcher = null
  }
}

export function stopBoardDesignWatch(): void {
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  selfWriteContent = null
}
