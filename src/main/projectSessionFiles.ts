import fs from 'node:fs'
import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { defaultPiAgentDir } from './piSettings'
import { sessionsRoot, sessionDirCandidatesFor } from './sessionHistory'

export interface ProjectSessionFile { path: string; dev: number; ino: number; uuid: string }

/** Find transcript copies by their own workspace header, never by renderer data. */
export async function discoverProjectSessionFiles(projectPath: string, agentDir = defaultPiAgentDir()): Promise<ProjectSessionFile[]> {
  const byProject = await scanProjectSessionFiles([projectPath], agentDir)
  return byProject.get(projectPath) ?? []
}

export async function discoverSessionMoveFiles(source: string, target: string, uuid: string, agentDir: string) {
  const byProject = await scanProjectSessionFiles([source, target], agentDir, uuid)
  return { sources: byProject.get(source) ?? [], destinations: byProject.get(target) ?? [] }
}

async function scanProjectSessionFiles(projects: readonly string[], agentDir: string, uuid?: string): Promise<Map<string, ProjectSessionFile[]>> {
  const files = new Map<string, ProjectSessionFile[]>(projects.map(project => [project, []]))
  let root: string
  try { root = canonicalExistingPath(sessionsRoot(agentDir)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files; throw error }
  const expected = new Set([...files.keys()].flatMap(project => sessionDirCandidatesFor(project, agentDir))
    .map(p => path.join(root, path.relative(sessionsRoot(agentDir), p))))
  const pending = [root]
  let visited = 0
  while (pending.length) {
    const dir = pending.pop()!
    let children: fs.Dirent[]
    try { children = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && dir === root) return files
      throw error
    }
    if ((visited += children.length) > 200000) throw new Error('session-scan-too-large')
    for (const child of children) {
      if (child.isSymbolicLink() && [...expected].some(candidate => candidate === path.join(dir, child.name) || candidate.startsWith(path.join(dir, child.name) + path.sep))) throw new Error('unsafe-session-directory')
      if (child.isDirectory() && !child.isSymbolicLink()) { pending.push(path.join(dir, child.name)); continue }
      if (!child.name.endsWith('.jsonl')) continue
      // A move concerns one identity. Unrelated damaged files must not block it,
      // but a damaged candidate named for this UUID could hide another copy.
      const required = uuid === undefined ? expected.has(path.resolve(dir))
        : child.name === `${uuid}.jsonl` || child.name.endsWith(`_${uuid}.jsonl`)
      if (!child.isFile() || child.isSymbolicLink()) { if (required) throw new Error('unsafe-session-file'); continue }
      const file = path.join(dir, child.name)
      let handle: fs.promises.FileHandle | undefined
      let matchesUuid = false
      try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
        const stat = await handle.stat()
        if (!stat.isFile() || canonicalExistingPath(file) !== file) throw new Error('unsafe-session-file')
        const bytes = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 5)
        let header: { type?: unknown; cwd?: unknown; id?: unknown } | undefined
        for (const line of lines) { try { const parsed = JSON.parse(line); if (parsed?.type === 'session') { header = parsed; break } } catch { /* tolerate title padding */ } }
        matchesUuid = uuid !== undefined && header?.id === uuid
        if (!header || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || typeof header.id !== 'string') {
          if (required || matchesUuid) throw new Error('unreadable-session-header')
          continue
        }
        if (uuid !== undefined && !matchesUuid) continue
        let cwd: string
        try { cwd = canonicalExistingPath(header.cwd) } catch (error) { if (matchesUuid) throw error; continue }
        files.get(cwd)?.push({ path: file, dev: stat.dev, ino: stat.ino, uuid: header.id })
      } catch (error) { if (required || matchesUuid) throw error }
      finally { await handle?.close() }
    }
  }
  return files
}
