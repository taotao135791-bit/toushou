import fs from 'node:fs'
import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { defaultPiAgentDir } from './piSettings'
import { sessionsRoot, sessionDirCandidatesFor } from './sessionHistory'

/** Find transcript copies by their own workspace header, never by renderer data. */
export async function discoverProjectSessionFiles(projectPath: string, agentDir = defaultPiAgentDir()): Promise<Array<{ path: string; dev: number; ino: number }>> {
  let root: string
  try { root = canonicalExistingPath(sessionsRoot(agentDir)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const expected = new Set(sessionDirCandidatesFor(projectPath, agentDir).map(p => path.join(root, path.relative(sessionsRoot(agentDir), p))))
  const files: Array<{ path: string; dev: number; ino: number }> = []
  const pending = [root]
  let visited = 0
  while (pending.length) {
    const dir = pending.pop()!
    let children: fs.Dirent[]
    try { children = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && dir === root) return []
      throw error
    }
    if ((visited += children.length) > 200000) throw new Error('session-scan-too-large')
    for (const child of children) {
      if (child.isSymbolicLink() && [...expected].some(candidate => candidate === path.join(dir, child.name) || candidate.startsWith(path.join(dir, child.name) + path.sep))) throw new Error('unsafe-session-directory')
      if (child.isDirectory() && !child.isSymbolicLink()) { pending.push(path.join(dir, child.name)); continue }
      if (!child.name.endsWith('.jsonl')) continue
      if (!child.isFile() || child.isSymbolicLink()) { if (expected.has(path.resolve(dir))) throw new Error('unsafe-session-file'); continue }
      const file = path.join(dir, child.name)
      let handle: fs.promises.FileHandle | undefined
      try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        const stat = await handle.stat()
        if (!stat.isFile() || canonicalExistingPath(file) !== file) throw new Error('unsafe-session-file')
        const bytes = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 5)
        let header: { type?: unknown; cwd?: unknown; id?: unknown } | undefined
        for (const line of lines) { try { const parsed = JSON.parse(line); if (parsed?.type === 'session') { header = parsed; break } } catch { /* tolerate title padding */ } }
        if (!header || typeof header.cwd !== 'string' || typeof header.id !== 'string') {
          if (expected.has(path.resolve(dir))) throw new Error('unreadable-session-header')
          continue
        }
        let cwd: string
        try { cwd = canonicalExistingPath(header.cwd) } catch { continue }
        if (cwd === projectPath) files.push({ path: file, dev: stat.dev, ino: stat.ino })
      } catch (error) { if (expected.has(path.resolve(dir))) throw error }
      finally { await handle?.close() }
    }
  }
  return files
}
