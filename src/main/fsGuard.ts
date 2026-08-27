import fs from 'node:fs'
import path from 'node:path'

/**
 * Path allowlist for fs:* IPC handlers. Pure logic, unit-testable.
 * The renderer can only list/read files under registered roots
 * (selected project folders and session working directories).
 *
 * All checks are done on real paths (symlinks resolved), never on lexical
 * paths alone: a lexical startsWith check is defeated by a symlink inside
 * the project pointing outside it (`project/link -> ~/.ssh`). Roots are
 * canonicalized at registration, so a root that is itself a symlink
 * (including macOS /tmp -> /private/tmp style aliases) works transparently.
 */
export class FsGuard {
  private roots = new Set<string>()

  /** Lexical resolve + realpath when the path exists (falls back to lexical). */
  private canonical(p: string): string {
    const resolved = path.resolve(p)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }

  addRoot(root: string): void {
    this.roots.add(this.canonical(root))
  }

  removeRoot(root: string): void {
    this.roots.delete(this.canonical(root))
  }

  private isWithinRoots(real: string): boolean {
    for (const root of this.roots) {
      if (real === root || real.startsWith(root + path.sep)) {
        return true
      }
    }
    return false
  }

  /**
   * Read/preview check. The target must exist: its real path (every symlink
   * component resolved) has to land inside a registered root. Nonexistent
   * paths and broken symlinks are denied — there is nothing to read, and
   * realpathSync failing must never crash the caller.
   */
  isAllowed(target: string): boolean {
    let real: string
    try {
      real = fs.realpathSync(path.resolve(target))
    } catch {
      return false
    }
    return this.isWithinRoots(real)
  }
}
