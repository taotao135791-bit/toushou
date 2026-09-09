import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HistorySessionDescriptor } from '../shared/types'
import {
  HistorySessionFile,
  deleteSessionCopiesByUuid,
  isSessionUuid,
  readSessionUuid,
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
   *
   * A capability that merely aged past its TTL is not rejected: once every
   * binding (owner, workspace, inode/uuid identity, workspace session dirs)
   * revalidates, the TTL slides forward. This keeps the freshness property
   * (unvalidated reuse stays impossible) while a row the user can still see
   * and open no longer fails its first click after a long idle.
   */
  async resolve(
    historyId: unknown,
    context: HistorySessionGrantContext
  ): Promise<string | null> {
    if (!validOpaqueId(historyId)) return null
    const stored = this.grants.get(historyId)
    if (
      !stored ||
      stored.ownerWebContentsId !== context.ownerWebContentsId ||
      stored.workspaceGrantId !== context.workspaceGrantId ||
      stored.workspaceRealPath !== context.workspaceRealPath
    ) {
      return null
    }

    const current = await inspectSessionFile(stored.realPath)
    if (!current) {
      // Missing file: keep the capability so the uuid-based delete fallback
      // (deleteStale) can still retire the row; the TTL sweeps it otherwise.
      return null
    }
    if (!sameIdentity(stored, current)) {
      // omp resume rewrites the session file in place (fork bookkeeping updates
      // the title/header lines), so the minted dev/ino identity drifts even
      // though the row still names the same session. Self-heal when the file's
      // header uuid still matches the minted descriptor; a CHANGED uuid means
      // the row is genuinely superseded.
      const uuidNow = await readSessionUuid(stored.realPath)
      if (uuidNow !== stored.descriptor.uuid) {
        this.remove(historyId)
        return null
      }
      const refreshed = current as PathIdentity
      stored.realPath = refreshed.realPath
      stored.dev = refreshed.dev
      stored.ino = refreshed.ino
    }
    if (!(await this.belongsToWorkspaceSessionDirs(stored.realPath, context.workspaceRealPath))) {
      this.remove(historyId)
      return null
    }
    if (stored.expiresAt <= this.now()) stored.expiresAt = this.now() + this.ttlMs
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

  /**
   * Delete fallback for a row whose file no longer matches the minted inode
   * identity (omp resume rewrote it in place) or vanished outright. The
   * owner/workspace/expiry binding is still enforced, and deletion sweeps by
   * the descriptor's uuid inside the runtime's sessions root — Main-side, so
   * no renderer path is ever trusted. True when the uuid no longer resolves
   * anywhere (deleted, or already gone — either way the row is dead).
   */
  async deleteStale(
    historyId: unknown,
    context: HistorySessionGrantContext
  ): Promise<boolean> {
    if (!validOpaqueId(historyId)) return false
    const stored = this.grants.get(historyId)
    if (
      !stored ||
      stored.ownerWebContentsId !== context.ownerWebContentsId ||
      stored.workspaceGrantId !== context.workspaceGrantId ||
      stored.workspaceRealPath !== context.workspaceRealPath
    ) {
      return false
    }
    // Age alone does not block the sweep: an expired-but-bound capability
    // still names the same session file, and a user deleting a row must not
    // depend on when the capability was last minted.
    const deleted = await deleteSessionCopiesByUuid(stored.descriptor.uuid, this.getAgentDir())
    if (deleted) this.remove(historyId)
    return deleted
  }

  /**
   * Delete EVERY durable copy of a session uuid across all projects and layout
   * generations, and revoke every capability minted for it. This is the
   * workspace-independent delete path: a cross-project history row carries only
   * its uuid (never a capability minted for the active workspace), and a deleted
   * session must not survive in a legacy-layout or sanitized-label copy for the
   * scanner to resurrect. Resolution and guarding happen Main-side inside the
   * runtime's own sessions root; the renderer never supplies a path.
   */
  async deleteByUuid(uuid: unknown): Promise<boolean> {
    this.pruneExpired()
    if (!isSessionUuid(uuid)) return false
    const deleted = await deleteSessionCopiesByUuid(uuid, this.getAgentDir())
    if (deleted) this.revokeUuid(uuid)
    return deleted
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

  /** Revoke every capability minted for a durable session uuid (any owner). */
  private revokeUuid(uuid: string): void {
    for (const [id, stored] of this.grants) {
      if (stored.descriptor.uuid === uuid) this.remove(id)
    }
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
