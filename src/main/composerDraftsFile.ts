import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ComposerDraftFile, ComposerDrafts, SessionComposerDraft } from '../shared/types'

const MAX_DRAFTS = 500
const MAX_DRAFT_TEXT_CHARS = 1_000_000
const MAX_DRAFT_IMAGES = 4
const MAX_DRAFT_IMAGE_CHARS = 14 * 1024 * 1024
const MAX_DRAFT_FILES = 32
const MAX_FILE_BYTES = 64 * 1024 * 1024
const DRAFT_KEY = /^[a-zA-Z0-9_:-]{1,256}$/
const DRAFT_FILENAME = /^[a-f0-9]{64}\.json$/

function draftFolder(): string {
  return path.join(app.getPath('userData'), 'composer-drafts')
}

function draftFilename(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`
}

function cleanFile(value: unknown): ComposerDraftFile | null {
  if (typeof value !== 'object' || value === null) return null
  const { path, name, isDirectory, kind } = value as Partial<ComposerDraftFile>
  if (typeof path !== 'string' || path.length > 8192 || typeof name !== 'string' || name.length > 4096 ||
      typeof isDirectory !== 'boolean' || (kind !== 'folder' && kind !== 'archive' && kind !== 'file')) return null
  return { path, name, isDirectory, kind }
}

function cleanDraft(value: unknown): SessionComposerDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const { text, images, files } = value as Partial<SessionComposerDraft>
  if (typeof text !== 'string' || text.length > MAX_DRAFT_TEXT_CHARS ||
      !Array.isArray(images) || images.length > MAX_DRAFT_IMAGES) return null
  const cleanImages: SessionComposerDraft['images'] = []
  for (const image of images) {
    if (!image || image.type !== 'image' || typeof image.data !== 'string' || image.data.length > MAX_DRAFT_IMAGE_CHARS ||
        typeof image.mimeType !== 'string' || image.mimeType.length > 128) return null
    cleanImages.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  const cleanFiles: ComposerDraftFile[] = []
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > MAX_DRAFT_FILES) return null
    for (const file of files) {
      const clean = cleanFile(file)
      if (!clean) return null
      cleanFiles.push(clean)
    }
  }
  return { text, images: cleanImages, ...(files === undefined ? {} : { files: cleanFiles }) }
}

async function readDraftJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > MAX_FILE_BYTES) return null
  return JSON.parse(await readFile(file, 'utf-8')) as unknown
}

async function writeDraft(folder: string, key: string, draft: SessionComposerDraft): Promise<boolean> {
  const file = path.join(folder, draftFilename(key))
  const temp = `${file}.tmp`
  const json = JSON.stringify({ key, draft })
  if (Buffer.byteLength(json, 'utf-8') > MAX_FILE_BYTES) return false
  try {
    await writeFile(temp, json, { encoding: 'utf-8', mode: 0o600 })
    await rename(temp, file)
    return true
  } catch {
    await rm(temp, { force: true }).catch(() => undefined)
    return false
  }
}

let migratingFolder: string | undefined
let migration: Promise<void> | undefined

function migrateLegacyDrafts(folder: string): Promise<void> {
  if (migratingFolder === folder && migration) return migration
  migratingFolder = folder
  const legacy = path.join(path.dirname(folder), 'composer-drafts.json')
  migration = (async () => {
    let parsed: unknown
    try { parsed = await readDraftJson(legacy) } catch (error) {
      if (error instanceof SyntaxError) await copyFile(legacy, `${legacy}.corrupt`).catch(() => undefined)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    await mkdir(folder, { recursive: true, mode: 0o700 })
    let migrated = true
    for (const [key, value] of Object.entries(parsed).slice(0, MAX_DRAFTS)) {
      const draft = DRAFT_KEY.test(key) ? cleanDraft(value) : null
      if (!draft) continue
      const current = path.join(folder, draftFilename(key))
      const exists = await stat(current).then(() => true, () => false)
      if (!exists && !(await writeDraft(folder, key, draft))) migrated = false
    }
    if (migrated) await rm(legacy)
  })().catch(() => undefined)
  return migration
}

let pendingWrite: Promise<boolean> = Promise.resolve(true)

export async function loadComposerDrafts(): Promise<ComposerDrafts> {
  const folder = draftFolder()
  await pendingWrite
  await migrateLegacyDrafts(folder)
  const files = await readdir(folder).catch(() => [])
  const drafts: ComposerDrafts = Object.create(null)
  for (const filename of files.filter((name) => DRAFT_FILENAME.test(name))) {
    const file = path.join(folder, filename)
    try {
      const entry = await readDraftJson(file) as { key?: unknown; draft?: unknown } | null
      if (typeof entry?.key !== 'string' || !DRAFT_KEY.test(entry.key) || draftFilename(entry.key) !== filename) continue
      const draft = cleanDraft(entry.draft)
      if (draft) drafts[entry.key] = draft
    } catch (error) {
      if (error instanceof SyntaxError) await copyFile(file, `${file}.corrupt`).catch(() => undefined)
    }
  }
  return drafts
}

/** Write changed drafts independently. A failed entry leaves its previous copy intact. */
export function saveComposerDrafts(value: unknown): Promise<boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return Promise.resolve(false)
  const changes = Object.entries(value)
  if (changes.length > MAX_DRAFTS) return Promise.resolve(false)
  const folder = draftFolder()
  pendingWrite = pendingWrite.then(async () => {
    await migrateLegacyDrafts(folder)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    let saved = true
    for (const [key, value] of changes) {
      if (!DRAFT_KEY.test(key)) {
        saved = false
      } else if (value === null) {
        await rm(path.join(folder, draftFilename(key)), { force: true }).catch(() => { saved = false })
      } else {
        const draft = cleanDraft(value)
        if (!draft || !(await writeDraft(folder, key, draft))) saved = false
      }
    }
    return saved
  }).catch(() => false)
  return pendingWrite
}
