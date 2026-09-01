import { app, shell } from 'electron'
import http from 'node:http'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  SkillEntry,
  SkillImportResult,
  SkillListResult,
  SkillOpenHtmlResult,
  SkillReadResult
} from '../shared/types'
import {
  SKILL_LIMITS,
  buildSkillEntry,
  isValidSkillId,
  sanitizeSkillFileName,
  skillExtensionOf,
  skillKindForExtension
} from '../shared/skills'

/**
 * SKILL 目录 persistence + loopback serving.
 *
 * The library is one flat folder (userData/skills) of self-contained files
 * the team shares — Markdown docs and single-file HTML tools. Files are
 * DATA: Markdown is rendered by the app's sandboxed renderer, and HTML is
 * served read-only from a loopback-only HTTP server so it opens inside the
 * existing hardened browser panel (sandboxed view, no preload, no disk
 * cookies) without weakening that panel's http(s)-only policy.
 *
 * Every renderer-supplied id is a validated basename (isValidSkillId), so
 * traversal cannot cross the boundary. importSkillFile is the only writer
 * and only accepts paths Main itself resolved from a one-use FileGrant.
 */

export function skillsDir(): string {
  return path.join(app.getPath('userData'), 'skills')
}

function readEntryOrNull(file: string): SkillEntry | null {
  let size: number
  let mtime: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return null
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return null
  }
  if (size > SKILL_LIMITS.maxFileBytes) return null
  const fileName = path.basename(file)
  const kind = skillKindForExtension(path.extname(fileName).slice(1).toLowerCase())
  if (!kind) return null
  try {
    return buildSkillEntry(fileName, kind, readFileSync(file, 'utf-8'), size, mtime)
  } catch {
    return null
  }
}

export function listSkills(dir: string = skillsDir()): SkillListResult {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, entries: [] }
    return { ok: false, error: 'skills-unreadable' }
  }
  const entries: SkillEntry[] = []
  for (const name of names) {
    if (entries.length >= SKILL_LIMITS.maxEntries) break
    if (!skillExtensionOf(name)) continue
    const entry = readEntryOrNull(path.join(dir, name))
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => b.updatedAtMillis - a.updatedAtMillis)
  return { ok: true, entries }
}

export function readSkill(id: unknown, dir: string = skillsDir()): SkillReadResult {
  if (!isValidSkillId(id)) return { ok: false, error: 'invalid-request' }
  const file = path.join(dir, id)
  const entry = readEntryOrNull(file)
  if (!entry) return { ok: false, error: 'not-found' }
  try {
    return { ok: true, entry, content: readFileSync(file, 'utf-8') }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
}

/** Pick a non-clashing sanitized target name inside the library. */
function resolveTargetName(sourceName: string, dir: string): string {
  const base = sanitizeSkillFileName(sourceName)
  if (!base) return ''
  if (!existsSyncSafe(path.join(dir, base))) return base
  const dot = base.lastIndexOf('.')
  const stem = base.slice(0, dot)
  const ext = base.slice(dot)
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (candidate.length > SKILL_LIMITS.maxFileNameLength) break
    if (!existsSyncSafe(path.join(dir, candidate))) return candidate
  }
  return ''
}

function existsSyncSafe(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

export function importSkillFile(sourcePath: string, dir: string = skillsDir()): SkillImportResult {
  let size: number
  try {
    const stat = statSync(sourcePath)
    if (!stat.isFile()) return { ok: false, error: 'invalid-file' }
    size = stat.size
  } catch {
    return { ok: false, error: 'invalid-path' }
  }
  if (size > SKILL_LIMITS.maxFileBytes) return { ok: false, error: 'too-large' }
  if (!skillExtensionOf(path.basename(sourcePath))) return { ok: false, error: 'invalid-file' }
  let content: string
  try {
    content = readFileSync(sourcePath, 'utf-8')
  } catch {
    return { ok: false, error: 'invalid-file' }
  }
  const entry = storeSkillContent(path.basename(sourcePath), content, dir)
  if (!entry) return { ok: false, error: 'write-failed' }
  return { ok: true, entry }
}

/**
 * Store validated content under a sanitized, collision-free name. Shared by
 * the local-file import and the GitHub import; returns null when the library
 * is full, unwritable, or nothing safe remains of the name.
 */
export function storeSkillContent(
  sourceName: string,
  content: string,
  dir: string
): SkillEntry | null {
  if (content.length > SKILL_LIMITS.maxFileBytes) return null
  if (!skillExtensionOf(sourceName)) return null
  const target = resolveTargetName(sourceName, dir)
  if (!target) return null
  const existing = listSkills(dir)
  if (!existing.ok) return null
  if (existing.entries.length >= SKILL_LIMITS.maxEntries) return null
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, target), content, 'utf-8')
  } catch {
    return null
  }
  return readEntryOrNull(path.join(dir, target))
}

export function revealSkillsDir(dir: string = skillsDir()): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    shell.showItemInFolder(dir)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Loopback HTML serving — one lazy server per app, bound to 127.0.0.1 with
// an OS-assigned port. Serves only validated library basenames; the Host
// header is pinned to the literal loopback authority so a DNS-rebound
// remote page cannot embed the server. No listing, no writes, no caching.
// ---------------------------------------------------------------------------

let serverUrlPromise: Promise<string> | null = null

/** Test seam: drop the singleton so a new dir can be served. */
export function stopSkillsServerForTests(): void {
  serverUrlPromise = null
}

async function ensureSkillsServer(dir: string): Promise<string> {
  if (!serverUrlPromise) {
    serverUrlPromise = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store')
        const host = req.headers.host ?? ''
        // Keep the hostname, strip an optional port: only the literal
        // loopback authority may be served (blocks DNS-rebinding embeds).
        const hostname = host.replace(/:\d+$/, '')
        if (req.method !== 'GET' || hostname !== '127.0.0.1') {
          res.statusCode = 403
          res.end()
          return
        }
        let id: string
        try {
          id = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(1))
        } catch {
          res.statusCode = 400
          res.end()
          return
        }
        const result = readSkill(id, dir)
        if (!result.ok) {
          res.statusCode = result.error === 'invalid-request' ? 400 : 404
          res.end()
          return
        }
        res.statusCode = 200
        res.setHeader(
          'Content-Type',
          result.entry.kind === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8'
        )
        res.end(result.content)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('skills server could not bind'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
    serverUrlPromise.catch(() => {
      serverUrlPromise = null
    })
  }
  return serverUrlPromise
}

export async function openSkillHtml(id: unknown, dir: string = skillsDir()): Promise<SkillOpenHtmlResult> {
  if (!isValidSkillId(id)) return { ok: false, error: 'invalid-request' }
  const peek = readSkill(id, dir)
  if (!peek.ok) {
    return { ok: false, error: peek.error === 'invalid-request' ? 'invalid-request' : 'not-found' }
  }
  if (peek.entry.kind !== 'html') return { ok: false, error: 'invalid-request' }
  try {
    const base = await ensureSkillsServer(dir)
    return { ok: true, url: `${base}/${encodeURIComponent(id)}` }
  } catch {
    return { ok: false, error: 'server-failed' }
  }
}
