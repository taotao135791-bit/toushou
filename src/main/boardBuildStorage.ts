import { AsyncLocalStorage } from 'node:async_hooks'
import { app } from 'electron'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const BOARD_STORE_FILES = ['kanban-boards-v2.json', 'board-datasets.json', 'appsflyer-dataset-specs.json'] as const
export type BoardStoreFile = typeof BOARD_STORE_FILES[number]
const context = new AsyncLocalStorage<string>()
let publishing = false
export const boardBuildRoot = (): string | undefined => context.getStore()
export const withBoardBuildRoot = <T>(root: string, operation: () => T): T => context.run(root, operation)
/** Beta shares authorization with stable, but never writes its board stores.
 * Only these data files are imported; credentials/configuration stay in place. */
export function boardProfileRoot(): string {
  const profile = app.getPath('userData')
  if (process.env.TOUSHOU_RELEASE_CHANNEL !== 'beta') return profile
  const overlay = path.join(profile, 'board-beta-v3')
  if (existsSync(path.join(overlay, 'overlay.json'))) return overlay
  if (existsSync(overlay)) throw new Error('beta-board-overlay-uninitialized')
  const staging = `${overlay}.init-${randomUUID()}`
  mkdirSync(path.join(staging, 'initial-source'), { recursive: true, mode: 0o700 })
  try {
    for (const name of [...BOARD_STORE_FILES, 'kanban-boards.json', 'html-boards.json']) {
      let bytes: string
      try { bytes = readFileSync(path.join(profile, name), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      atomicBoardFile(path.join(staging, name), bytes)
      atomicBoardFile(path.join(staging, 'initial-source', name), bytes)
    }
    atomicBoardFile(path.join(staging, 'overlay.json'), JSON.stringify({ version: 3, importedAt: Date.now() }))
    renameSync(staging, overlay)
    syncDirectory(profile)
    return overlay
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
function syncDirectory(root: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(root, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function atomicBoardFile(file: string, bytes: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const fd = openSync(temporary, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
    syncDirectory(path.dirname(file))
  } finally { rmSync(temporary, { force: true }) }
}

/** Only fixed filenames are restored; persisted paths are never trusted. */
export function recoverBoardBuild(root = boardProfileRoot()): void {
  if (publishing) return
  const file = path.join(root, 'board-build-publication.json')
  if (!existsSync(file)) return
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; before?: unknown }
  if (raw.version !== 1 || !raw.before || typeof raw.before !== 'object' || Array.isArray(raw.before) || Object.keys(raw.before).length !== BOARD_STORE_FILES.length) throw new Error('invalid-board-build-journal')
  const before = raw.before as Record<string, unknown>
  if (Object.keys(before).some(name => !BOARD_STORE_FILES.includes(name as BoardStoreFile)) || BOARD_STORE_FILES.some(name => before[name] !== null && typeof before[name] !== 'string')) throw new Error('invalid-board-build-journal')
  for (const name of BOARD_STORE_FILES) {
    if (before[name] === null) rmSync(path.join(root, name), { force: true })
    else atomicBoardFile(path.join(root, name), before[name] as string)
  }
  rmSync(file)
  syncDirectory(root)
}

export function boardStoragePath(name: BoardStoreFile): string {
  const root = context.getStore()
  if (root) return path.join(root, name)
  recoverBoardBuild()
  return path.join(boardProfileRoot(), name)
}

export function readBoardStoreBytes(root: string): Record<BoardStoreFile, string | null> {
  return Object.fromEntries(BOARD_STORE_FILES.map(name => {
    try { return [name, readFileSync(path.join(root, name), 'utf8')] } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, null]
      throw error
    }
  })) as Record<BoardStoreFile, string | null>
}

/** Synchronous Main publication plus a rollback journal: no IPC observer sees
 * intermediate files; a crash rolls all stores back on their next read. */
export function publishBoardBuild(root: string, before: Record<BoardStoreFile, string | null>, after: Record<BoardStoreFile, string | null>): void {
  const journal = path.join(root, 'board-build-publication.json')
  atomicBoardFile(journal, JSON.stringify({ version: 1, before }))
  publishing = true
  try {
    for (const name of BOARD_STORE_FILES) {
      if (after[name] === null) rmSync(path.join(root, name), { force: true })
      else atomicBoardFile(path.join(root, name), after[name]!)
    }
    rmSync(journal)
    syncDirectory(root)
  } catch (error) {
    publishing = false
    recoverBoardBuild(root)
    throw error
  } finally { publishing = false }
}
