import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DirectoryGrant, FileGrant, PluginScaffoldOutput } from '../shared/types'

/** Grants are intentionally short-lived, one-operation capabilities. */
export const OPERATION_GRANT_TTL_MS = 10 * 60 * 1000

interface PathIdentity {
  realPath: string
  dev: number
  ino: number
}

interface StoredFileGrant extends PathIdentity {
  grant: FileGrant
  ownerWebContentsId: number
  expiresAt: number
}

/**
 * A minted write target for the office save-as flow. The file itself may not
 * exist yet, so no dev/ino identity is stored — the resolved path is
 * re-derived (parent realpath + basename) at consume time instead.
 */
interface StoredOfficeSaveGrant {
  realPath: string
  grant: FileGrant
  ownerWebContentsId: number
  expiresAt: number
}

interface StoredDirectoryGrant extends PathIdentity {
  grant: DirectoryGrant
  ownerWebContentsId: number
  expiresAt: number
}

interface StoredScaffoldOutput extends PathIdentity {
  output: PluginScaffoldOutput
  ownerWebContentsId: number
  expiresAt: number
}

export interface OperationGrantManagerOptions {
  /** Test seam; production uses Date.now. */
  now?: () => number
  /** Test seam; production uses a ten-minute lifetime. */
  ttlMs?: number
}

const CONTROL_RE = /[\x00-\x1f\x7f]/
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FILE_GRANT_ID_RE = new RegExp(`^file-grant-${UUID_BODY}$`, 'i')
const DIRECTORY_GRANT_ID_RE = new RegExp(`^directory-grant-${UUID_BODY}$`, 'i')
const SCAFFOLD_OUTPUT_ID_RE = new RegExp(`^scaffold-output-${UUID_BODY}$`, 'i')

function validTrustedPath(value: string): boolean {
  return value.length > 0 && value.length <= 32_768 && !CONTROL_RE.test(value)
}

function validGrantId(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length <= 100 && !CONTROL_RE.test(value) && pattern.test(value)
}

async function inspectFile(candidate: string): Promise<PathIdentity | null> {
  if (!validTrustedPath(candidate)) return null
  try {
    const realPath = await fs.promises.realpath(path.resolve(candidate))
    const stat = await fs.promises.stat(realPath)
    if (!stat.isFile()) return null
    return { realPath, dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

async function inspectDirectory(candidate: string): Promise<PathIdentity | null> {
  if (!validTrustedPath(candidate)) return null
  try {
    const realPath = await fs.promises.realpath(path.resolve(candidate))
    const stat = await fs.promises.stat(realPath)
    if (!stat.isDirectory()) return null
    return { realPath, dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

/**
 * Canonicalize a not-yet-existing write target: the parent directory must
 * resolve to a real directory; the target is realParent + basename. Used for
 * office save-as grants, whose file typically does not exist at mint time.
 */
async function resolveSaveTargetPath(candidate: string): Promise<string | null> {
  if (!validTrustedPath(candidate)) return null
  const absolute = path.resolve(candidate)
  const base = path.basename(absolute)
  if (!base || base === '.' || base === '..') return null
  try {
    const realParent = await fs.promises.realpath(path.dirname(absolute))
    const stat = await fs.promises.stat(realParent)
    if (!stat.isDirectory()) return null
    return path.join(realParent, base)
  } catch {
    return null
  }
}

function sameIdentity(expected: PathIdentity, actual: PathIdentity | null): actual is PathIdentity {
  return (
    actual !== null &&
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  )
}

/**
 * Main-only capabilities for non-workspace file operations.
 *
 * The mint methods accept a path solely because Main receives it from a native
 * picker (or trusted preload File extraction). The renderer only ever sees
 * the public grant object, which contains no usable path, and all consumers
 * resolve the opaque id to this manager's private canonical path.
 */
export class OperationGrantManager {
  private readonly fileGrants = new Map<string, StoredFileGrant>()
  private readonly officeSaveGrants = new Map<string, StoredOfficeSaveGrant>()
  private readonly directoryGrants = new Map<string, StoredDirectoryGrant>()
  private readonly scaffoldOutputs = new Map<string, StoredScaffoldOutput>()
  /** One pending grant per owner/purpose bounds renderer-triggered minting. */
  private readonly fileGrantByOwner = new Map<string, string>()
  private readonly officeSaveGrantByOwner = new Map<number, string>()
  private readonly directoryGrantByOwner = new Map<number, string>()
  private readonly scaffoldOutputByOwner = new Map<number, string>()
  private readonly directoryLeases = new Set<string>()
  private readonly scaffoldOutputInstallLeases = new Set<string>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(opts: OperationGrantManagerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? OPERATION_GRANT_TTL_MS
  }

  /** Minted only after the user picks/drops a dataset file through a trusted UI path. */
  async mintBoardDatasetFile(
    trustedFilePath: string,
    ownerWebContentsId: number
  ): Promise<FileGrant | null> {
    return this.mintFileGrant('board-dataset-import', trustedFilePath, ownerWebContentsId)
  }

  /**
   * Resolve and consume a dataset file grant. Consumption happens before I/O
   * so even concurrent renderer calls cannot reuse one selection.
   */
  async consumeBoardDatasetFile(id: unknown, ownerWebContentsId: number): Promise<string | null> {
    return this.consumeFileGrant('board-dataset-import', id, ownerWebContentsId)
  }

  /**
   * Minted after a native office open-dialog pick, or in Main when a runtime
   * extension's open_panel request passes validateOfficePath.
   */
  async mintOfficeFile(trustedFilePath: string, ownerWebContentsId: number): Promise<FileGrant | null> {
    return this.mintFileGrant('office-open', trustedFilePath, ownerWebContentsId)
  }

  /** Resolve and consume an office read grant (one-shot, like dataset grants). */
  async consumeOfficeFile(id: unknown, ownerWebContentsId: number): Promise<string | null> {
    return this.consumeFileGrant('office-open', id, ownerWebContentsId)
  }

  private async mintFileGrant(
    purpose: 'board-dataset-import' | 'office-open',
    trustedFilePath: string,
    ownerWebContentsId: number
  ): Promise<FileGrant | null> {
    this.pruneExpired()
    const identity = await inspectFile(trustedFilePath)
    if (!identity) return null
    const createdAt = this.now()
    const grant: FileGrant = {
      id: `file-grant-${crypto.randomUUID()}`,
      purpose,
      name: path.basename(identity.realPath),
      createdAt
    }
    const ownerKey = `${ownerWebContentsId}:${purpose}`
    const previous = this.fileGrantByOwner.get(ownerKey)
    if (previous) this.removeFileGrant(previous)
    this.fileGrants.set(grant.id, {
      ...identity,
      grant,
      ownerWebContentsId,
      expiresAt: createdAt + this.ttlMs
    })
    this.fileGrantByOwner.set(ownerKey, grant.id)
    return { ...grant }
  }

  private async consumeFileGrant(
    purpose: 'board-dataset-import' | 'office-open',
    id: unknown,
    ownerWebContentsId: number
  ): Promise<string | null> {
    this.pruneExpired()
    if (!validGrantId(id, FILE_GRANT_ID_RE)) return null
    const stored = this.fileGrants.get(id)
    if (!stored || stored.grant.purpose !== purpose || stored.ownerWebContentsId !== ownerWebContentsId) {
      return null
    }
    this.removeFileGrant(id)
    const current = await inspectFile(stored.realPath)
    return stored.expiresAt > this.now() && sameIdentity(stored, current) ? stored.realPath : null
  }

  /**
   * Minted after a native office save-as dialog pick. The target may not exist
   * yet: the canonical path is parent realpath + basename, and it is re-derived
   * at consume time (a swapped parent directory invalidates the grant).
   */
  async mintOfficeSaveTarget(
    trustedFilePath: string,
    ownerWebContentsId: number
  ): Promise<FileGrant | null> {
    this.pruneExpired()
    const resolved = await resolveSaveTargetPath(trustedFilePath)
    if (!resolved) return null
    const createdAt = this.now()
    const grant: FileGrant = {
      id: `file-grant-${crypto.randomUUID()}`,
      purpose: 'office-save',
      name: path.basename(resolved),
      createdAt
    }
    const previous = this.officeSaveGrantByOwner.get(ownerWebContentsId)
    if (previous) this.removeOfficeSaveGrant(previous)
    this.officeSaveGrants.set(grant.id, {
      realPath: resolved,
      grant,
      ownerWebContentsId,
      expiresAt: createdAt + this.ttlMs
    })
    this.officeSaveGrantByOwner.set(ownerWebContentsId, grant.id)
    return { ...grant }
  }

  /** Resolve and consume an office write grant (one-shot). */
  async consumeOfficeSaveTarget(id: unknown, ownerWebContentsId: number): Promise<string | null> {
    this.pruneExpired()
    if (!validGrantId(id, FILE_GRANT_ID_RE)) return null
    const stored = this.officeSaveGrants.get(id)
    if (!stored || stored.ownerWebContentsId !== ownerWebContentsId) return null
    this.removeOfficeSaveGrant(id)
    if (stored.expiresAt <= this.now()) return null
    const current = await resolveSaveTargetPath(stored.realPath)
    return current === stored.realPath ? stored.realPath : null
  }

  /** Minted only after the user picks the scaffold parent directory natively. */
  async mintPluginScaffoldDirectory(
    trustedDirectoryPath: string,
    ownerWebContentsId: number
  ): Promise<DirectoryGrant | null> {
    this.pruneExpired()
    const identity = await inspectDirectory(trustedDirectoryPath)
    if (!identity) return null
    const createdAt = this.now()
    const grant: DirectoryGrant = {
      id: `directory-grant-${crypto.randomUUID()}`,
      purpose: 'plugin-scaffold',
      // Keep all absolute paths in Main. The renderer only needs a label.
      name: path.basename(identity.realPath) || 'folder',
      createdAt
    }
    const previous = this.directoryGrantByOwner.get(ownerWebContentsId)
    if (previous) this.removeDirectoryGrant(previous)
    this.directoryGrants.set(grant.id, {
      ...identity,
      grant,
      ownerWebContentsId,
      expiresAt: createdAt + this.ttlMs
    })
    this.directoryGrantByOwner.set(ownerWebContentsId, grant.id)
    return { ...grant }
  }

  /**
   * Lease a selected directory for one scaffold attempt. Failed validation or
   * writes release the lease for a retry; a successful scaffold consumes it.
   */
  async claimPluginScaffoldDirectory(
    id: unknown,
    ownerWebContentsId: number
  ): Promise<{ id: string; parentDir: string } | null> {
    this.pruneExpired()
    if (!validGrantId(id, DIRECTORY_GRANT_ID_RE) || this.directoryLeases.has(id)) return null
    const stored = this.directoryGrants.get(id)
    if (
      !stored ||
      stored.grant.purpose !== 'plugin-scaffold' ||
      stored.ownerWebContentsId !== ownerWebContentsId
    ) {
      return null
    }
    // Reserve synchronously before the filesystem revalidation awaits. Two
    // same-renderer IPC invocations must not both acquire the same directory
    // capability while the first stat/realpath is in flight.
    this.directoryLeases.add(id)
    const current = await inspectDirectory(stored.realPath)
    if (
      this.directoryGrants.get(id) !== stored ||
      stored.expiresAt <= this.now() ||
      !sameIdentity(stored, current)
    ) {
      if (this.directoryGrants.get(id) === stored) this.removeDirectoryGrant(id)
      else this.directoryLeases.delete(id)
      return null
    }
    return { id, parentDir: stored.realPath }
  }

  /** Finish a claimed scaffold attempt, consuming the capability on success. */
  finishPluginScaffoldDirectory(id: string, success: boolean): void {
    this.directoryLeases.delete(id)
    if (success) this.removeDirectoryGrant(id)
  }

  /**
   * Keep the successful scaffold directory in Main long enough to reveal or
   * install it. This is deliberately a separate capability from the selected
   * parent directory: a renderer never receives the produced absolute path.
   */
  async mintPluginScaffoldOutput(
    trustedDirectoryPath: string,
    ownerWebContentsId: number
  ): Promise<PluginScaffoldOutput | null> {
    this.pruneExpired()
    const identity = await inspectDirectory(trustedDirectoryPath)
    if (!identity) return null
    const createdAt = this.now()
    const output: PluginScaffoldOutput = {
      id: `scaffold-output-${crypto.randomUUID()}`,
      name: path.basename(identity.realPath) || 'plugin',
      createdAt
    }
    const previous = this.scaffoldOutputByOwner.get(ownerWebContentsId)
    if (previous) this.removeScaffoldOutput(previous)
    this.scaffoldOutputs.set(output.id, {
      ...identity,
      output,
      ownerWebContentsId,
      expiresAt: createdAt + this.ttlMs
    })
    this.scaffoldOutputByOwner.set(ownerWebContentsId, output.id)
    return { ...output }
  }

  /** Resolve a still-owned scaffold output for Main's reveal handler. */
  async revealPluginScaffoldOutput(id: unknown, ownerWebContentsId: number): Promise<string | null> {
    this.pruneExpired()
    if (!validGrantId(id, SCAFFOLD_OUTPUT_ID_RE)) return null
    const stored = this.scaffoldOutputs.get(id)
    if (!stored || stored.ownerWebContentsId !== ownerWebContentsId) return null
    const current = await inspectDirectory(stored.realPath)
    if (
      this.scaffoldOutputs.get(id) !== stored ||
      stored.expiresAt <= this.now() ||
      !sameIdentity(stored, current)
    ) {
      if (this.scaffoldOutputs.get(id) === stored) this.removeScaffoldOutput(id)
      return null
    }
    return stored.realPath
  }

  /**
   * Reserve a scaffold output for one install attempt. The id is not consumed
   * until the package manager succeeds, so a transient install failure can be
   * retried without re-exposing its filesystem path.
   */
  async claimPluginScaffoldOutputInstall(
    id: unknown,
    ownerWebContentsId: number
  ): Promise<{ id: string; dir: string } | null> {
    this.pruneExpired()
    if (!validGrantId(id, SCAFFOLD_OUTPUT_ID_RE) || this.scaffoldOutputInstallLeases.has(id)) {
      return null
    }
    const stored = this.scaffoldOutputs.get(id)
    if (!stored || stored.ownerWebContentsId !== ownerWebContentsId) return null
    this.scaffoldOutputInstallLeases.add(id)
    const current = await inspectDirectory(stored.realPath)
    if (
      this.scaffoldOutputs.get(id) !== stored ||
      stored.expiresAt <= this.now() ||
      !sameIdentity(stored, current)
    ) {
      if (this.scaffoldOutputs.get(id) === stored) this.removeScaffoldOutput(id)
      else this.scaffoldOutputInstallLeases.delete(id)
      return null
    }
    return { id, dir: stored.realPath }
  }

  /** Finish a claimed output install; only a successful install consumes it. */
  finishPluginScaffoldOutputInstall(id: string, success: boolean): void {
    this.scaffoldOutputInstallLeases.delete(id)
    if (success) this.removeScaffoldOutput(id)
  }

  /** Drop all short-lived capabilities owned by a destroyed renderer. */
  revokeOwner(ownerWebContentsId: number): void {
    for (const [key, id] of this.fileGrantByOwner) {
      if (key.startsWith(`${ownerWebContentsId}:`)) this.removeFileGrant(id)
    }
    const saveId = this.officeSaveGrantByOwner.get(ownerWebContentsId)
    if (saveId) this.removeOfficeSaveGrant(saveId)
    const directoryId = this.directoryGrantByOwner.get(ownerWebContentsId)
    if (directoryId) this.removeDirectoryGrant(directoryId)
    const outputId = this.scaffoldOutputByOwner.get(ownerWebContentsId)
    if (outputId) this.removeScaffoldOutput(outputId)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, stored] of this.fileGrants) {
      if (stored.expiresAt <= now) this.removeFileGrant(id)
    }
    for (const [id, stored] of this.officeSaveGrants) {
      if (stored.expiresAt <= now) this.removeOfficeSaveGrant(id)
    }
    for (const [id, stored] of this.directoryGrants) {
      if (stored.expiresAt <= now) this.removeDirectoryGrant(id)
    }
    for (const [id, stored] of this.scaffoldOutputs) {
      if (stored.expiresAt <= now) this.removeScaffoldOutput(id)
    }
  }

  private removeFileGrant(id: string): void {
    const stored = this.fileGrants.get(id)
    this.fileGrants.delete(id)
    const ownerKey = stored ? `${stored.ownerWebContentsId}:${stored.grant.purpose}` : null
    if (stored && ownerKey && this.fileGrantByOwner.get(ownerKey) === id) {
      this.fileGrantByOwner.delete(ownerKey)
    }
  }

  private removeOfficeSaveGrant(id: string): void {
    const stored = this.officeSaveGrants.get(id)
    this.officeSaveGrants.delete(id)
    if (stored && this.officeSaveGrantByOwner.get(stored.ownerWebContentsId) === id) {
      this.officeSaveGrantByOwner.delete(stored.ownerWebContentsId)
    }
  }

  private removeDirectoryGrant(id: string): void {
    const stored = this.directoryGrants.get(id)
    this.directoryGrants.delete(id)
    this.directoryLeases.delete(id)
    if (stored && this.directoryGrantByOwner.get(stored.ownerWebContentsId) === id) {
      this.directoryGrantByOwner.delete(stored.ownerWebContentsId)
    }
  }

  private removeScaffoldOutput(id: string): void {
    const stored = this.scaffoldOutputs.get(id)
    this.scaffoldOutputs.delete(id)
    this.scaffoldOutputInstallLeases.delete(id)
    if (stored && this.scaffoldOutputByOwner.get(stored.ownerWebContentsId) === id) {
      this.scaffoldOutputByOwner.delete(stored.ownerWebContentsId)
    }
  }
}

/**
 * Process-wide shared instance. ipc.ts and the omp panel-open broadcast both
 * mint/consume grants; a singleton keeps them on the same registry without a
 * circular import.
 */
let sharedManager: OperationGrantManager | null = null

export function getOperationGrantManager(): OperationGrantManager {
  sharedManager ??= new OperationGrantManager()
  return sharedManager
}
