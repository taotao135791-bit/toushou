import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * FB snapshot archive — the evidence chain behind browser-panel readings.
 *
 * Every successful snapshot of a facebook.com page taken through the
 * browser-use bridge is archived best-effort to a single JSON document at
 * userData/fb-snapshots.json, written atomically (tmp + rename, same pattern
 * as boards / board-datasets). Entries keep the page URL, title, and bounded
 * body text — the exact input a later parser (D3-4) will read — so numbers
 * always have a verifiable source, parser regressions can be reproduced
 * offline against saved snapshots, and FB layout changes never force extra
 * live visits to debug. The archive deliberately excludes the interactive
 * element table: parsing works off text, and element payloads would inflate
 * the store. Growth is bounded by pruning to the newest FB_SNAPSHOT_LIMITS
 * entries. Archiving must never break a read: callers treat the result as
 * advisory.
 */

export const FB_SNAPSHOT_LIMITS = {
  maxEntries: 200,
  maxUrlLength: 2_048,
  maxTitleLength: 500,
  maxTextChars: 20_000
} as const

export interface FbSnapshotEntry {
  id: string
  /** ISO timestamp of the moment the snapshot was taken. */
  capturedAt: string
  url: string
  title: string
  text: string
}

export interface FbSnapshotInput {
  url: string
  title: string
  text: string
}

export type FbSnapshotAppendResult =
  | { ok: true; entry: FbSnapshotEntry }
  | { ok: false; error: string }

/** True for facebook.com and any subdomain (adsmanager/business/www). */
export function isFacebookSnapshotUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    return host === 'facebook.com' || host.endsWith('.facebook.com')
  } catch {
    return false
  }
}

/** Pure input validation — the bridge layer pre-checks, tests exercise this. */
export function validateFbSnapshotInput(value: unknown): FbSnapshotInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.url !== 'string' || typeof v.title !== 'string' || typeof v.text !== 'string') {
    return null
  }
  if (!isFacebookSnapshotUrl(v.url)) return null
  if (v.url.length > FB_SNAPSHOT_LIMITS.maxUrlLength) return null
  return {
    url: v.url,
    title: v.title.slice(0, FB_SNAPSHOT_LIMITS.maxTitleLength),
    text: v.text.slice(0, FB_SNAPSHOT_LIMITS.maxTextChars)
  }
}

/** Drop invalid entries and keep only the newest maxEntries. Pure. */
export function normalizeFbSnapshots(raw: unknown, maxEntries: number = FB_SNAPSHOT_LIMITS.maxEntries): FbSnapshotEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: FbSnapshotEntry[] = []
  for (const item of raw) {
    const entry = validateFbSnapshotEntry(item)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
  return entries.slice(Math.max(0, entries.length - maxEntries))
}

function validateFbSnapshotEntry(value: unknown): FbSnapshotEntry | null {
  const input = validateFbSnapshotInput(value)
  if (!input) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id || v.id.length > 100) return null
  if (typeof v.capturedAt !== 'string' || Number.isNaN(Date.parse(v.capturedAt))) return null
  return { id: v.id, capturedAt: v.capturedAt, ...input }
}

function defaultSnapshotsFile(): string {
  return path.join(app.getPath('userData'), 'fb-snapshots.json')
}

function readSnapshots(file: string): FbSnapshotEntry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the FB snapshot archive.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The FB snapshot archive is not valid JSON.')
  }
  return normalizeFbSnapshots(raw)
}

function writeSnapshots(file: string, entries: FbSnapshotEntry[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

/** Newest-first listing for future IPC / debugging surfaces. */
export function listFbSnapshots(file: string = defaultSnapshotsFile()): FbSnapshotEntry[] {
  return readSnapshots(file).reverse()
}

/**
 * Append one archived snapshot. Corrupt or unreadable stores fail closed
 * (no destructive rewrite) but the caller decides how loud to be — the
 * browser-use bridge archives fire-and-forget.
 */
export function appendFbSnapshot(value: unknown, file: string = defaultSnapshotsFile()): FbSnapshotAppendResult {
  const input = validateFbSnapshotInput(value)
  if (!input) return { ok: false, error: 'invalid-snapshot' }
  let entries: FbSnapshotEntry[]
  try {
    entries = readSnapshots(file)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const entry: FbSnapshotEntry = {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    ...input
  }
  const next = normalizeFbSnapshots([...entries, entry])
  try {
    writeSnapshots(file, next)
    return { ok: true, entry }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Test/inspection helper: whether the archive file exists yet. */
export function fbSnapshotsFileExists(file: string = defaultSnapshotsFile()): boolean {
  return existsSync(file)
}
