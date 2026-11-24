import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { ComposerDrafts, SessionComposerDraft } from '../shared/types'

/**
 * Composer-draft disk persistence. Drafts ride outside electron-store on
 * purpose: a draft with a few pasted images is megabytes of base64, far past
 * the settings channel's 256KB plain-value cap, and settings are not worth
 * bloating for text the user has not sent yet. This file is the single
 * durable copy, validated on both read and write.
 */

const MAX_DRAFTS = 500
const MAX_DRAFT_TEXT_CHARS = 100_000
const MAX_DRAFT_IMAGES = 4
const MAX_DRAFT_IMAGE_CHARS = 14 * 1024 * 1024
const MAX_DRAFT_FILES = 32
const MAX_FILE_BYTES = 16 * 1024 * 1024

function draftsFile(): string {
  return path.join(app.getPath('userData'), 'composer-drafts.json')
}

function isDraftFile(value: unknown): value is Exclude<SessionComposerDraft['files'], undefined>[number] {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    typeof file.path === 'string' && typeof file.name === 'string' &&
    typeof file.isDirectory === 'boolean' &&
    (file.kind === 'folder' || file.kind === 'archive' || file.kind === 'file')
  )
}

/** Validate one draft entry; invalid entries are dropped, never throw. */
function isSessionDraft(value: unknown): value is SessionComposerDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  if (typeof draft.text !== 'string' || draft.text.length > MAX_DRAFT_TEXT_CHARS) return false
  if (!Array.isArray(draft.images) || draft.images.length > MAX_DRAFT_IMAGES) return false
  for (const image of draft.images) {
    if (typeof image !== 'object' || image === null) return false
    const entry = image as Record<string, unknown>
    if (entry.type !== 'image' || typeof entry.data !== 'string' || typeof entry.mimeType !== 'string') return false
    if (entry.data.length > MAX_DRAFT_IMAGE_CHARS) return false
  }
  if (draft.files !== undefined) {
    if (!Array.isArray(draft.files) || draft.files.length > MAX_DRAFT_FILES) return false
    for (const file of draft.files) if (!isDraftFile(file)) return false
  }
  return true
}

/**
 * Read the persisted drafts. A missing, corrupt, or partially invalid file
 * degrades to whatever valid entries survive (empty when none) — an unsent
 * draft must never block startup.
 */
export function loadComposerDrafts(): ComposerDrafts {
  let raw: string
  try {
    raw = readFileSync(draftsFile(), 'utf-8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Keep the corrupt bytes for manual recovery, same policy as settings.
    try {
      copyFileSync(draftsFile(), `${draftsFile()}.corrupt`)
    } catch {
      // A read-only volume has nothing better to offer; empty drafts it is.
    }
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const drafts: ComposerDrafts = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 256 || !isSessionDraft(value)) continue
    drafts[key] = value
  }
  return drafts
}

/**
 * Persist drafts atomically (tmp + rename) so a crash mid-write can never
 * truncate the previous copy. Returns false when the payload is not valid
 * plain draft data or exceeds the size budget.
 */
export function saveComposerDrafts(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_DRAFTS) return false
  const drafts: ComposerDrafts = {}
  let bytes = 0
  for (const [key, draft] of entries) {
    if (key.length === 0 || key.length > 256 || !isSessionDraft(draft)) return false
    drafts[key] = draft
    bytes += key.length + draft.text.length
    for (const image of draft.images) bytes += image.data.length
  }
  if (bytes > MAX_FILE_BYTES) return false
  const file = draftsFile()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(drafts), 'utf-8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
