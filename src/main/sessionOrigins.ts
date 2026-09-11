import { app } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export type SessionOrigin = 'feishu' | 'task'

interface StoredOriginEntry {
  sessionFile: string
  origin: SessionOrigin
  recordedAt: number
}

/** Keeps the index small even on long-lived installs. */
const MAX_ENTRIES = 1000

/**
 * Durable session-file → origin ('feishu' | 'task') index, Main-only.
 *
 * `Session.origin` lives in the in-memory live registry and is lost on quit;
 * the durable JSONL transcript has no notion of who spawned it. This index is
 * the bridge that lets the history scanner badge restart-surviving rows: it is
 * recorded whenever Main spawns/resumes a session with a known origin and is
 * consulted when listing/resuming history. Entries are pruned when their file
 * disappears and capped to the newest MAX_ENTRIES.
 */
export class SessionOriginIndex {
  private readonly filePath: string
  private readonly entries = new Map<string, StoredOriginEntry>()
  private loaded: Promise<void> | null = null

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? path.join(app.getPath('userData'), 'session-origins.json')
  }

  /** Await before the first lookup so a fast renderer cannot race the load. */
  ready(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const value = item as Record<string, unknown>
        if (
          typeof value.sessionFile !== 'string' ||
          !value.sessionFile ||
          (value.origin !== 'feishu' && value.origin !== 'task')
        ) {
          continue
        }
        this.entries.set(this.key(value.sessionFile), {
          sessionFile: value.sessionFile,
          origin: value.origin,
          recordedAt: typeof value.recordedAt === 'number' ? value.recordedAt : 0
        })
      }
    } catch {
      // First launch or a corrupt optional index: start cleanly.
    }
  }

  record(sessionFile: string, origin: SessionOrigin): void {
    if (typeof sessionFile !== 'string' || !sessionFile) return
    this.entries.set(this.key(sessionFile), { sessionFile, origin, recordedAt: Date.now() })
    void this.persist()
  }

  lookup(sessionFile: string): SessionOrigin | undefined {
    if (typeof sessionFile !== 'string' || !sessionFile) return undefined
    return this.entries.get(this.key(sessionFile))?.origin
  }

  private key(sessionFile: string): string {
    try {
      return realpathSync(sessionFile)
    } catch {
      // Missing file (or a lookup racing its creation): the lexical path is
      // the only form available; record() on the same lexical path still hits.
      return path.resolve(sessionFile)
    }
  }

  private async persist(): Promise<void> {
    try {
      // Prune entries whose transcript is gone before writing, and cap the
      // index to the newest recordings.
      const alive: StoredOriginEntry[] = []
      for (const entry of this.entries.values()) {
        if (await stat(entry.sessionFile).then(() => true, () => false)) alive.push(entry)
        else this.entries.delete(this.key(entry.sessionFile))
      }
      alive.sort((a, b) => b.recordedAt - a.recordedAt)
      for (const stale of alive.slice(MAX_ENTRIES)) this.entries.delete(this.key(stale.sessionFile))
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFile(
        this.filePath,
        JSON.stringify(alive.slice(0, MAX_ENTRIES)),
        'utf8'
      )
    } catch {
      // The index stays live in memory if the optional file cannot be written.
    }
  }
}
