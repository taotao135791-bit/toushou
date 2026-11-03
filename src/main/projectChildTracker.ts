import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { pathsOverlap } from './projectDeletionGate'

/** Keep removed sessions busy until their process has actually stopped. */
export class ProjectChildTracker {
  private readonly retiring = new Map<string, string>()

  watch(id: string, cwd: string, child: {
    pid?: number
    once(event: 'exit', listener: () => void): unknown
    once(event: 'error', listener: () => void): unknown
  }): () => void {
    let recordedCwd = path.resolve(cwd)
    try { recordedCwd = canonicalExistingPath(recordedCwd) } catch { /* preserve lexical path */ }
    let exited = false
    const finish = () => { exited = true; this.retiring.delete(id) }
    child.once('exit', finish)
    // A spawn failure has no child process to wait for. Other errors (e.g.
    // kill failure) do not prove a successfully spawned child has exited.
    child.once('error', () => { if (child.pid === undefined) finish() })
    return () => { if (!exited) this.retiring.set(id, recordedCwd) }
  }

  hasRetiringOverlap(projectPath: string): boolean {
    return [...this.retiring.values()].some(cwd => pathsOverlap(projectPath, cwd))
  }
}
