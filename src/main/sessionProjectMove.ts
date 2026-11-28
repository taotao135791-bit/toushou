import { constants, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { defaultPiAgentDir } from './piSettings'
import { isSessionUuid, ompSessionDirCandidatesFor, sessionsRoot } from './sessionHistory'
import { discoverSessionMoveFiles } from './projectSessionFiles'

const HEADER_BYTES = 64 * 1024
const moving = new Set<string>()

export function isSessionMoving(uuid: unknown): boolean {
  return isSessionUuid(uuid) && moving.has(uuid)
}

export async function withSessionMove<T>(uuid: string, move: () => Promise<T>): Promise<T | 'busy'> {
  if (moving.has(uuid)) return 'busy'
  moving.add(uuid)
  try { return await move() } finally { moving.delete(uuid) }
}

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function rewriteHeader(head: Buffer, uuid: string, source: string, target: string): { prefix: Buffer; offset: number } | undefined {
  let start = 0
  for (let line = 0; line < 5 && start < head.length; line++) {
    const end = head.indexOf(10, start)
    const limit = end === -1 ? head.length : end
    const bytes = head.subarray(start, limit)
    let header: Record<string, unknown> | undefined
    try { header = JSON.parse(bytes.toString('utf8')) } catch { /* Optional title and preamble. */ }
    if (header?.type === 'session') {
      if (header.id !== uuid || typeof header.cwd !== 'string' || canonicalExistingPath(header.cwd) !== source) return
      const newline = end === -1 ? '' : bytes.at(-1) === 13 ? '\r\n' : '\n'
      return {
        prefix: Buffer.concat([head.subarray(0, start), Buffer.from(JSON.stringify({ ...header, cwd: target }) + newline)]),
        offset: end === -1 ? limit : end + 1
      }
    }
    if (end === -1) return
    start = end + 1
  }
}

export type MoveJournalResult =
  | { ok: true; sourceFile: string; filePath: string }
  | { ok: false; error: 'not-found' | 'conflict' | 'busy' | 'failed' }

/** Relocate the complete JSONL journal under the destination workspace's OMP session directory. */
export async function moveSessionJournal(options: {
  uuid: string
  source: string
  target: string
  agentDir?: string
  available: () => boolean
  prepare: (sourceFile: string) => Promise<boolean>
}): Promise<MoveJournalResult> {
  const { uuid, source, target, available, prepare, agentDir = defaultPiAgentDir() } = options
  if (!isSessionUuid(uuid)) return { ok: false, error: 'not-found' }
  try {
    if (!available() || canonicalExistingPath(source) !== source || canonicalExistingPath(target) !== target) return { ok: false, error: 'busy' }
    const { sources, destinations } = await discoverSessionMoveFiles(source, target, uuid, agentDir)
    if (!sources.length) return { ok: false, error: 'not-found' }
    if (sources.length > 1) return { ok: false, error: 'conflict' }
    const [{ path: sourceFile }] = sources
    if (source === target) return { ok: true, sourceFile, filePath: sourceFile }
    if (destinations.length) return { ok: false, error: 'conflict' }
    if (!available()) return { ok: false, error: 'busy' }

    const root = canonicalExistingPath(sessionsRoot(agentDir))
    const [preferred, hashed] = ompSessionDirCandidatesFor(target, agentDir, canonicalExistingPath)
    const directoryName = path.basename(preferred) === path.basename(path.dirname(sourceFile)) ? path.basename(hashed) : path.basename(preferred)
    const directory = path.join(root, directoryName)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory() || canonicalExistingPath(directory) !== directory) return { ok: false, error: 'failed' }
    const filePath = path.join(directory, path.basename(sourceFile))
    const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing) return { ok: false, error: 'conflict' }

    // OMP can flush more records as it stops. Stage the final journal only
    // after the writer exits so that normal shutdown writes are included.
    if (!available() || !await prepare(sourceFile) || !available()) return { ok: false, error: 'busy' }
    const temporary = path.join(directory, `.move-${randomUUID()}.tmp`)
    const input = await open(sourceFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let published = false
    let completed = false
    try {
      const before = await input.stat({ bigint: true })
      if (!before.isFile() || canonicalExistingPath(sourceFile) !== sourceFile) return { ok: false, error: 'failed' }
      const head = Buffer.allocUnsafe(HEADER_BYTES)
      const { bytesRead } = await input.read(head, 0, head.length, 0)
      const header = rewriteHeader(head.subarray(0, bytesRead), uuid, source, target)
      if (!header) return { ok: false, error: 'not-found' }
      if (canonicalExistingPath(directory) !== directory) return { ok: false, error: 'busy' }
      const output = await open(temporary, 'wx', before.mode > 0n ? Number(before.mode & 0o777n) : 0o600)
      try {
        await output.writeFile(header.prefix)
        const buffer = Buffer.allocUnsafe(256 * 1024)
        let offset = header.offset
        const size = Number(before.size)
        while (offset < size) {
          const length = Math.min(buffer.length, size - offset)
          const { bytesRead } = await input.read(buffer, 0, length, offset)
          if (!bytesRead) throw new Error('source-journal-changed')
          await output.writeFile(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        await output.sync()
      } finally { await output.close() }
      await input.close()
      if (!available() || canonicalExistingPath(directory) !== directory || canonicalExistingPath(sourceFile) !== sourceFile || !unchanged(before, await lstat(sourceFile, { bigint: true }))) return { ok: false, error: 'busy' }
      // Link publishes the finished journal atomically and never overwrites an existing conversation.
      await link(temporary, filePath)
      published = true
      if (!available() || canonicalExistingPath(sourceFile) !== sourceFile || !unchanged(before, await lstat(sourceFile, { bigint: true }))) return { ok: false, error: 'busy' }
      await unlink(sourceFile)
      completed = true
      return { ok: true, sourceFile, filePath }
    } finally {
      await input.close()
      if (published && !completed) {
        try {
          const staged = await lstat(temporary, { bigint: true })
          const destination = await lstat(filePath, { bigint: true })
          if (unchanged(staged, destination)) await unlink(filePath)
        } catch { /* Never remove an unrelated file that replaced the publication. */ }
      }
      await unlink(temporary).catch(() => undefined)
    }
  } catch (error) {
    return { ok: false, error: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'failed' }
  }
}
