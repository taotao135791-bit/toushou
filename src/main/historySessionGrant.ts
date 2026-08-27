import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HistorySessionDescriptor } from '../shared/types'
import {
  HistorySessionFile,
  sessionDirCandidatesFor,
  sessionsRoot
} from './sessionHistory'
import { defaultPiAgentDir } from './piSettings'

/** History capabilities are intentionally short-lived and Main-owned. */
export const HISTORY_SESSION_GRANT_TTL_MS = 10 * 60 * 1000

interface PathIdentity {
  realPath: string
  dev: number
  ino: number
}

interface StoredHistorySessionGrant extends PathIdentity {
  descriptor: HistorySessionDescriptor
  workspaceGrantId: string
  workspaceRealPath: string
  ownerWebContentsId: number
  expiresAt: number
}

export interface HistorySessionGrantContext {
  workspaceGrantId: string
  workspaceRealPath: string
  ownerWebContentsId: number
}

export interface HistorySessionGrantManagerOptions {
  /** Test seam; production uses Date.now. */
  now?: () => number
  /** Test seam; production uses a ten-minute lifetime. */
  ttlMs?: number
  /** Test seam; production resolves the detected OMP agent directory per use. */
  agentDir?: string
}

const CONTROL_RE = /[\x00-\x1f\x7f]/
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const HISTORY_SESSION_GRANT_ID_RE = new RegExp(`^history-session-${UUID_BODY}$`, 'i')

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    !CONTROL_RE.test(value) &&
    HISTORY_SESSION_GRANT_ID_RE.test(value)
  )
}

function isChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sameIdentity(expected: PathIdentity, actual: PathIdentity | null): actual is PathIdentity {
  return (
    actual !== null &&
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  )
}

async function inspectSessionFile(candidate: string): Promise<PathIdentity | null> {
  if (typeof candidate !== 'string' || !candidate.endsWith('.jsonl') || CONTROL_RE.test(candidate)) {
    return null
  }
  try {
    const realPath = await fs.promises.realpath(path.resolve(candidate))
    if (!realPath.endsWith('.jsonl')) return null
    const stat = await fs.promises.stat(realPath)
    if (!stat.isFile()) return null
    return { realPath, dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

/**
 * Maps durable session records to opaque capabilities. This is deliberately
 * separate from WorkspaceGrantManager: session files are not workspace files,
 * and session authority must be tied to both an active workspace grant and the
 * renderer that requested the list.
 */
export class HistorySessionGrantManager {
  private readonly grants = new Map<string, StoredHistorySessionGrant>()
  private readonly grantIdsByOwnerWorkspace = new Map<string, Set<string>>()
  /** Prevent concurrent resume/delete operations from racing the same capability. */
  private readonly leases = new Set<string>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly getAgentDir: () => string

  constructor(opts: HistorySessionGrantManagerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? HISTORY_SESSION_GRANT_TTL_MS
    this.getAgentDir = opts.agentDir ? () => opts.agentDir as string : defaultPiAgentDir
  }

  /**
   * Replace the caller's prior history capabilities for this exact workspace.
   * A refresh therefore revokes stale IDs instead of leaving an unbounded set
   * of old file references reachable from the renderer.
   */
  async mintForWorkspace(
    history: readonly HistorySessionFile[],
    context: HistorySessionGrantContext
  ): Promise<HistorySessionDescriptor[]> {
    this.pruneExpired()
    this.revokeOwnerWorkspace(context.ownerWebContentsId, context.workspaceGrantId)

    const descriptors: HistorySessionDescriptor[] = []
    const seenPaths = new Set<string>()
    for (const entry of history) {
      const identity = await inspectSessionFile(entry.filePath)
      if (
        !identity ||
        seenPaths.has(identity.realPath) ||
        !(await this.belongsToWorkspaceSessionDirs(identity.realPath, context.workspaceRealPath))
      ) {
        continue
      }
      seenPaths.add(identity.realPath)

      const createdAt = this.now()
      const descriptor: HistorySessionDescriptor = {
        id: `history-session-${crypto.randomUUID()}`,
        uuid: entry.uuid,
        title: entry.title,
        timestamp: entry.timestamp
      }
      this.grants.set(descriptor.id, {
        ...identity,
        descriptor,
        workspaceGrantId: context.workspaceGrantId,
        workspaceRealPath: context.workspaceRealPath,
        ownerWebContentsId: context.ownerWebContentsId,
        expiresAt: createdAt + this.ttlMs
      })
      this.idsFor(context.ownerWebContentsId, context.workspaceGrantId).add(descriptor.id)
      descriptors.push({ ...descriptor })
    }
    return descriptors
  }

  /**
   * Resolve a history capability to its private session file path. Every use
   * re-checks the opaque id's owner/workspace binding, canonical inode identity,
   * and membership of the active workspace's known OMP session directories.
   */
  async resolve(
    historyId: unknown,
    context: HistorySessionGrantContext
  ): Promise<string | null> {
    this.pruneExpired()
    if (!validOpaqueId(historyId)) return null
    const stored = this.grants.get(historyId)
    if (
      !stored ||
      stored.ownerWebContentsId !== context.ownerWebContentsId ||
      stored.workspaceGrantId !== context.workspaceGrantId ||
      stored.workspaceRealPath !== context.workspaceRealPath ||
      stored.expiresAt <= this.now()
    ) {
      return null
    }

    const current = await inspectSessionFile(stored.realPath)
    if (
      !sameIdentity(stored, current) ||
      !(await this.belongsToWorkspaceSessionDirs(stored.realPath, context.workspaceRealPath))
    ) {
      this.remove(historyId)
      return null
    }
    return stored.realPath
  }

  /**
   * Revalidate and temporarily claim one history capability while Main carries
   * out an operation. The callback never crosses IPC, so the renderer cannot
   * substitute a checked path between validation and resume/delete dispatch.
   */
  async withResolved<T>(
    historyId: unknown,
    context: HistorySessionGrantContext,
    operation: (filePath: string) => Promise<T>
  ): Promise<T | null> {
    if (!validOpaqueId(historyId) || this.leases.has(historyId)) return null
    this.leases.add(historyId)
    try {
      const filePath = await this.resolve(historyId, context)
      if (!filePath) return null
      return await operation(filePath)
    } finally {
      this.leases.delete(historyId)
    }
  }

  /** Revoke one capability after a destructive operation succeeds. */
  revoke(historyId: unknown): boolean {
    if (!validOpaqueId(historyId)) return false
    return this.remove(historyId)
  }

  /** Revoke all history capabilities tied to a workspace grant. */
  revokeWorkspace(workspaceGrantId: string): void {
    for (const [id, stored] of this.grants) {
      if (stored.workspaceGrantId === workspaceGrantId) this.remove(id)
    }
  }

  /** Revoke all capabilities held by a renderer once its webContents is gone. */
  revokeOwner(ownerWebContentsId: number): void {
    for (const [id, stored] of this.grants) {
      if (stored.ownerWebContentsId === ownerWebContentsId) this.remove(id)
    }
  }

  /** Drop elapsed capabilities. Exposed for deterministic tests. */
  pruneExpired(): void {
    const now = this.now()
    for (const [id, stored] of this.grants) {
      if (stored.expiresAt <= now) this.remove(id)
    }
  }

  private async belongsToWorkspaceSessionDirs(fileRealPath: string, workspaceRealPath: string): Promise<boolean> {
    if (!fileRealPath.endsWith('.jsonl')) return false
    const agentDir = this.getAgentDir()

    let sessionsRootRealPath: string
    try {
      sessionsRootRealPath = await fs.promises.realpath(sessionsRoot(agentDir))
    } catch {
      return false
    }

    for (const candidate of sessionDirCandidatesFor(workspaceRealPath, agentDir)) {
      const lexicalCandidate = path.resolve(candidate)
      // Do not follow a session-directory symlink outside the agent's sessions
      // root just because it happens to have the expected generated name.
      if (!isChildPath(lexicalCandidate, path.resolve(sessionsRoot(agentDir)))) continue
      try {
        const directoryRealPath = await fs.promises.realpath(lexicalCandidate)
        const stat = await fs.promises.stat(directoryRealPath)
        if (
          !stat.isDirectory() ||
          !isChildPath(directoryRealPath, sessionsRootRealPath) ||
          !isChildPath(fileRealPath, directoryRealPath)
        ) {
          continue
        }
        return true
      } catch {
        // This layout may not exist; check the remaining known layouts.
      }
    }
    return false
  }

  private idsFor(ownerWebContentsId: number, workspaceGrantId: string): Set<string> {
    const key = `${ownerWebContentsId}\u0000${workspaceGrantId}`
    let ids = this.grantIdsByOwnerWorkspace.get(key)
    if (!ids) {
      ids = new Set<string>()
      this.grantIdsByOwnerWorkspace.set(key, ids)
    }
    return ids
  }

  private revokeOwnerWorkspace(ownerWebContentsId: number, workspaceGrantId: string): void {
    const key = `${ownerWebContentsId}\u0000${workspaceGrantId}`
    const ids = this.grantIdsByOwnerWorkspace.get(key)
    if (!ids) return
    for (const id of [...ids]) this.remove(id)
  }

  private remove(historyId: string): boolean {
    const stored = this.grants.get(historyId)
    if (!stored) return false
    this.grants.delete(historyId)
    this.leases.delete(historyId)
    const key = `${stored.ownerWebContentsId}\u0000${stored.workspaceGrantId}`
    const ids = this.grantIdsByOwnerWorkspace.get(key)
    if (ids) {
      ids.delete(historyId)
      if (ids.size === 0) this.grantIdsByOwnerWorkspace.delete(key)
    }
    return true
  }
}
