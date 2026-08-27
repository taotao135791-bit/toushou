import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RecentWorkspaceDescriptor, WorkspaceGrant } from '../shared/types'
import { FsGuard } from './fsGuard'

/**
 * Main-owned workspace authority.
 *
 * The renderer can never create a filesystem grant by itself. It can only:
 *   - ask the user to pick a folder via the native dialog
 *   - ask Main to activate a persisted recent workspace
 *   - ask Main to activate an existing workspace it already holds a grant for
 *
 * Main validates the path (exists, is a directory, realpath) and mints a
 * WorkspaceGrant. The canonical realPath is registered with FsGuard; workspace-
 * sensitive IPC handlers require a grant id and resolve it to realPath internally.
 */

export type GrantSource = WorkspaceGrant['source']

export interface GrantManagerOptions {
  fsGuard: FsGuard
}

export interface RecentWorkspaceRegistryOptions {
  readPaths: () => string[]
  writePaths: (paths: string[]) => void
}

function recentWorkspaceId(realPath: string): string {
  return `recent-${crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 24)}`
}

function workspaceName(displayPath: string): string | undefined {
  const name = path.basename(displayPath)
  return name && name !== path.parse(displayPath).root ? name : undefined
}

/** Main-owned registry that turns persisted paths into opaque, revalidated ids. */
export class RecentWorkspaceRegistry {
  constructor(
    private readonly grants: WorkspaceGrantManager,
    private readonly opts: RecentWorkspaceRegistryOptions
  ) {}

  async list(): Promise<RecentWorkspaceDescriptor[]> {
    const descriptors: RecentWorkspaceDescriptor[] = []
    const canonicalPaths: string[] = []
    const seen = new Set<string>()

    for (const persistedPath of this.opts.readPaths()) {
      if (typeof persistedPath !== 'string' || !persistedPath.trim()) continue
      const realPath = await this.validateDirectory(persistedPath)
      if (!realPath || seen.has(realPath)) continue
      seen.add(realPath)
      canonicalPaths.push(realPath)
      descriptors.push({
        id: recentWorkspaceId(realPath),
        displayPath: realPath,
        name: workspaceName(realPath)
      })
    }

    // Persist only the current canonical paths. A deleted or replaced entry is
    // never treated as a durable capability or left stale in the registry.
    const current = this.opts.readPaths()
    if (current.length !== canonicalPaths.length || current.some((value, i) => value !== canonicalPaths[i])) {
      this.opts.writePaths(canonicalPaths)
    }
    return descriptors
  }

  async activate(id: unknown): Promise<WorkspaceGrant | null> {
    if (typeof id !== 'string' || !id.trim()) return null
    const descriptor = (await this.list()).find((entry) => entry.id === id)
    if (!descriptor) return null
    // The registry is re-read and canonicalized above on every activation. The
    // grant therefore follows the current target, not a cached old realpath.
    return this.grants.createGrant(descriptor.displayPath, 'recent-project')
  }

  async clear(): Promise<void> {
    this.opts.writePaths([])
  }

  async remove(displayPath: unknown): Promise<boolean> {
    if (typeof displayPath !== 'string' || !displayPath.trim()) return false
    const descriptors = await this.list()
    if (!descriptors.some((entry) => entry.displayPath === displayPath)) return false
    this.opts.writePaths(descriptors.filter((entry) => entry.displayPath !== displayPath).map((entry) => entry.displayPath))
    return true
  }

  private async validateDirectory(candidate: string): Promise<string | null> {
    try {
      const normalized = path.resolve(candidate)
      const stat = await fs.promises.stat(normalized)
      if (!stat.isDirectory()) return null
      return await fs.promises.realpath(normalized)
    } catch {
      return null
    }
  }
}

export class WorkspaceGrantManager {
  private grants = new Map<string, WorkspaceGrant>()
  private fsGuard: FsGuard

  constructor(opts: GrantManagerOptions) {
    this.fsGuard = opts.fsGuard
  }

  /** Create a grant from a trusted source. Returns null if the path is invalid. */
  async createGrant(displayPath: string, source: GrantSource): Promise<WorkspaceGrant | null> {
    const normalized = path.resolve(displayPath)
    let realPath: string
    try {
      const st = await fs.promises.stat(normalized)
      if (!st.isDirectory()) return null
      realPath = fs.realpathSync(normalized)
    } catch {
      return null
    }

    // If an equivalent realPath grant already exists, reuse it (new displayPath).
    const existing = this.findByRealPath(realPath)
    if (existing) {
      const refreshed: WorkspaceGrant = {
        ...existing,
        displayPath,
        source
      }
      this.grants.set(existing.id, refreshed)
      return refreshed
    }

    const grant: WorkspaceGrant = {
      id: `grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      realPath,
      displayPath,
      source,
      createdAt: Date.now()
    }
    this.grants.set(grant.id, grant)
    this.fsGuard.addRoot(realPath)
    return grant
  }

  /** Look up a grant by id. */
  get(id: string): WorkspaceGrant | undefined {
    return this.grants.get(id)
  }

  /** All active grants. */
  list(): WorkspaceGrant[] {
    return Array.from(this.grants.values())
  }

  /** Remove a grant and its FsGuard root. */
  revoke(id: string): boolean {
    const grant = this.grants.get(id)
    if (!grant) return false
    this.grants.delete(id)
    this.fsGuard.removeRoot(grant.realPath)
    return true
  }

  private findByRealPath(realPath: string): WorkspaceGrant | undefined {
    for (const g of this.grants.values()) {
      if (g.realPath === realPath) return g
    }
    return undefined
  }
}
