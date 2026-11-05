import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { isSessionFilePath, sessionDirCandidatesFor } from './sessionHistory'

/** Fail closed unless this existing transcript belongs to the exact task workspace. */
export async function taskSessionBelongsToWorkspace(file: string, cwd: string, agentDir?: string): Promise<boolean> {
  if (!path.isAbsolute(file) || !path.isAbsolute(cwd) || !isSessionFilePath(file, agentDir)) return false
  try {
    const workspace = canonicalExistingPath(cwd)
    const actual = canonicalExistingPath(file)
    const parent = path.dirname(actual)
    const allowed = sessionDirCandidatesFor(cwd, agentDir).some(candidate => {
      try { return canonicalExistingPath(candidate) === parent } catch { return false }
    })
    if (!allowed) return false
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return false
      const buffer = Buffer.alloc(256 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 5)) {
        try {
          const item: unknown = JSON.parse(line)
          if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'session') continue
          const header = item as { id?: unknown; cwd?: unknown }
          return typeof header.id === 'string' && !!header.id && typeof header.cwd === 'string' && path.isAbsolute(header.cwd) && canonicalExistingPath(header.cwd) === workspace && canonicalExistingPath(file) === actual
        } catch { /* ignore unrelated title or malformed records */ }
      }
      return false
    } finally { await handle.close() }
  } catch { return false }
}
