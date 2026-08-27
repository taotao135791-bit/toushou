import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PackageLocalSourceGrant } from '../shared/types'

/** Local install selections deliberately expire instead of becoming saved paths. */
export const PACKAGE_LOCAL_SOURCE_GRANT_TTL_MS = 10 * 60 * 1000

interface PathIdentity {
  realPath: string
  dev: number
  ino: number
  kind: PackageLocalSourceGrant['kind']
}

interface StoredPackageLocalSourceGrant extends PathIdentity {
  grant: PackageLocalSourceGrant
  ownerWebContentsId: number
  expiresAt: number
}

export interface PackageLocalSourceLease {
  /** Opaque id held for one Main-side install attempt. */
  id: string
  /** Display data only; it never includes the selected path. */
  grant: PackageLocalSourceGrant
}

export interface PackageLocalSourceGrantManagerOptions {
  now?: () => number
  ttlMs?: number
}

const CONTROL_RE = /[\x00-\x1f\x7f]/
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const GRANT_ID_RE = new RegExp(`^package-local-source-${UUID_BODY}$`, 'i')

function validPath(value: string): boolean {
  return value.length > 0 && value.length <= 32_768 && !CONTROL_RE.test(value)
}

function validGrantId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && !CONTROL_RE.test(value) && GRANT_ID_RE.test(value)
}

function copyGrant(grant: PackageLocalSourceGrant): PackageLocalSourceGrant {
  return { ...grant }
}

async function inspectSource(candidate: string): Promise<PathIdentity | null> {
  if (!validPath(candidate)) return null
  try {
    const realPath = await fs.promises.realpath(path.resolve(candidate))
    const stat = await fs.promises.stat(realPath)
    if (!stat.isDirectory() && !stat.isFile()) return null
    const kind: PackageLocalSourceGrant['kind'] = stat.isDirectory() ? 'directory' : 'file'
    return { realPath, dev: stat.dev, ino: stat.ino, kind }
  } catch {
    return null
  }
}

function sameIdentity(expected: PathIdentity, actual: PathIdentity | null): actual is PathIdentity {
  return (
    actual !== null &&
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.kind === expected.kind
  )
}

/**
 * Main-owned source selections for a local package install.
 *
 * A renderer can ask Main to open a native chooser or pass a genuine Finder
 * File through preload, but it receives only this opaque record. Main checks
 * realpath/device/inode both when claiming and immediately after the native
 * confirmation before it passes the canonical path to the package CLI.
 */
export class PackageLocalSourceGrantManager {
  private readonly grants = new Map<string, StoredPackageLocalSourceGrant>()
  private readonly grantIdByOwner = new Map<number, string>()
  private readonly leases = new Set<string>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: PackageLocalSourceGrantManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PACKAGE_LOCAL_SOURCE_GRANT_TTL_MS
  }

  /** Mint from a native chooser path or trusted preload File extraction only. */
  async mint(trustedPath: string, ownerWebContentsId: number): Promise<PackageLocalSourceGrant | null> {
    this.pruneExpired()
    const identity = await inspectSource(trustedPath)
    if (!identity) return null

    const createdAt = this.now()
    const grant: PackageLocalSourceGrant = {
      id: `package-local-source-${crypto.randomUUID()}`,
      purpose: 'package-local-install',
      name: path.basename(identity.realPath) || 'package',
      kind: identity.kind,
      createdAt
    }
    const previous = this.grantIdByOwner.get(ownerWebContentsId)
    if (previous) this.remove(previous)
    this.grants.set(grant.id, {
      ...identity,
      grant,
      ownerWebContentsId,
      expiresAt: createdAt + this.ttlMs
    })
    this.grantIdByOwner.set(ownerWebContentsId, grant.id)
    return copyGrant(grant)
  }

  /** Reserve a source selection for a single Main-side installation. */
  async claim(id: unknown, ownerWebContentsId: number): Promise<PackageLocalSourceLease | null> {
    this.pruneExpired()
    if (!validGrantId(id) || this.leases.has(id)) return null
    const stored = this.grants.get(id)
    if (!stored || stored.ownerWebContentsId !== ownerWebContentsId || stored.expiresAt <= this.now()) {
      return null
    }
    this.leases.add(id)
    const source = await this.revalidate(id, ownerWebContentsId)
    if (!source) return null
    return { id, grant: copyGrant(stored.grant) }
  }

  /**
   * Re-check the still-claimed source after native confirmation and return the
   * private canonical path only to Main. Callers must never forward it over
   * IPC or include it in an action log.
   */
  async resolveClaimedPath(id: string, ownerWebContentsId: number): Promise<string | null> {
    if (!this.leases.has(id)) return null
    return this.revalidate(id, ownerWebContentsId)
  }

  /** A successful install consumes the selection; failures can be retried. */
  finish(id: string, success: boolean): void {
    this.leases.delete(id)
    if (success) this.remove(id)
  }

  revokeOwner(ownerWebContentsId: number): void {
    const id = this.grantIdByOwner.get(ownerWebContentsId)
    if (id) this.remove(id)
  }

  private async revalidate(id: string, ownerWebContentsId: number): Promise<string | null> {
    const stored = this.grants.get(id)
    if (
      !stored ||
      stored.ownerWebContentsId !== ownerWebContentsId ||
      stored.expiresAt <= this.now()
    ) {
      if (stored) this.remove(id)
      else this.leases.delete(id)
      return null
    }
    const current = await inspectSource(stored.realPath)
    if (this.grants.get(id) !== stored || !sameIdentity(stored, current)) {
      if (this.grants.get(id) === stored) this.remove(id)
      else this.leases.delete(id)
      return null
    }
    return stored.realPath
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, stored] of this.grants) {
      if (stored.expiresAt <= now) this.remove(id)
    }
  }

  private remove(id: string): void {
    const stored = this.grants.get(id)
    this.grants.delete(id)
    this.leases.delete(id)
    if (stored && this.grantIdByOwner.get(stored.ownerWebContentsId) === id) {
      this.grantIdByOwner.delete(stored.ownerWebContentsId)
    }
  }
}
