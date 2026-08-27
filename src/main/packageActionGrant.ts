import crypto from 'node:crypto'
import {
  PackageDescriptor,
  PackageInfo,
  PackageManagerProfile,
  PackageScope
} from '../shared/types'

/** Package action snapshots are short-lived renderer capabilities. */
export const PACKAGE_ACTION_GRANT_TTL_MS = 10 * 60 * 1000

const CONTROL_RE = /[\x00-\x1f\x7f]/
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PACKAGE_ACTION_ID_RE = new RegExp(`^package-action-${UUID_BODY}$`, 'i')

/**
 * The only package-row shape intended for a renderer.
 *
 * In particular, this deliberately excludes the command target, scope, and
 * install path. Those values can contain private local paths and are never an
 * authorization token; Main holds them in the matching PackageActionTarget.
 */
/** Backward-compatible Main-side name for the public package row projection. */
export type PackageActionDescriptor = PackageDescriptor

/** Main-only command identity resolved from an opaque descriptor id. */
export interface PackageActionTarget {
  source: string
  commandSource?: string
  scope?: PackageScope
  profile: PackageManagerProfile
}

export interface PackageActionGrantContext {
  ownerWebContentsId: number
  profile: PackageManagerProfile
}

export interface PackageActionGrantLease {
  /** The opaque id claimed by Main; pass it to finishPackageAction. */
  id: string
  /** Safe row data for diagnostics; it contains no raw command target. */
  descriptor: PackageActionDescriptor
  /** Main-only target for packages.ts. Never forward this to the renderer. */
  target: PackageActionTarget
}

interface StoredPackageActionGrant {
  descriptor: PackageActionDescriptor
  target: PackageActionTarget
  ownerWebContentsId: number
  expiresAt: number
}

export interface PackageActionGrantManagerOptions {
  /** Test seam; production uses Date.now. */
  now?: () => number
  /** Test seam; production uses a ten-minute lifetime. */
  ttlMs?: number
}

function validGrantId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    !CONTROL_RE.test(value) &&
    PACKAGE_ACTION_ID_RE.test(value)
  )
}

function copyResources(
  resources: ReadonlyArray<PackageDescriptor['resources'][number]>
): PackageDescriptor['resources'] {
  return resources.map((resource) => ({ type: resource.type, name: resource.name }))
}

function copyDescriptor(descriptor: PackageActionDescriptor): PackageActionDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    name: descriptor.name,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
    enabled: descriptor.enabled,
    resources: copyResources(descriptor.resources),
    pinned: descriptor.pinned,
    ...(descriptor.canUpdate === undefined ? {} : { canUpdate: descriptor.canUpdate }),
    ...(descriptor.marketplaceKey === undefined ? {} : { marketplaceKey: descriptor.marketplaceKey })
  }
}

function npmMarketplaceKey(source: string): string | undefined {
  const spec = source.replace(/^npm:/i, '')
  if (!spec) return undefined
  const separator = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
  const name = separator < 0 ? spec : spec.slice(0, separator)
  return /^[a-z0-9@._/-]+$/i.test(name) ? `npm:${name.toLowerCase()}` : undefined
}

function githubMarketplaceKey(source: string): string | undefined {
  let body = source.replace(/^git:/i, '').replace(/@[^/@]+$/, '').replace(/\.git$/i, '')
  try {
    const url = new URL(body)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    body = url.pathname.replace(/^\/+/, '')
  } catch {
    const shorthand = body.match(/^(?:git@)?github\.com[:/]([^/]+\/[^/]+)$/i)
    if (!shorthand) return undefined
    body = shorthand[1]
  }
  const normalized = body.replace(/^\/+|\/+$/g, '')
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(normalized)
    ? `github:${normalized.toLowerCase()}`
    : undefined
}

function marketplaceKeyFor(pkg: PackageInfo): string | undefined {
  if (pkg.kind === 'npm') return npmMarketplaceKey(pkg.commandSource ?? pkg.source)
  if (pkg.kind === 'git') return githubMarketplaceKey(pkg.commandSource ?? pkg.source)
  return undefined
}

function copyTarget(target: PackageActionTarget): PackageActionTarget {
  return {
    source: target.source,
    ...(target.commandSource === undefined ? {} : { commandSource: target.commandSource }),
    ...(target.scope === undefined ? {} : { scope: target.scope }),
    profile: target.profile
  }
}

function descriptorFor(pkg: PackageInfo, id: string): PackageActionDescriptor {
  const marketplaceKey = marketplaceKeyFor(pkg)
  return {
    id,
    kind: pkg.kind,
    name: pkg.name,
    ...(pkg.description === undefined ? {} : { description: pkg.description }),
    ...(pkg.version === undefined ? {} : { version: pkg.version }),
    enabled: pkg.enabled,
    resources: copyResources(pkg.resources),
    pinned: pkg.pinned,
    ...(pkg.canUpdate === undefined ? {} : { canUpdate: pkg.canUpdate }),
    ...(marketplaceKey === undefined ? {} : { marketplaceKey })
  }
}

function targetFor(pkg: PackageInfo, profile: PackageManagerProfile): PackageActionTarget {
  return {
    source: pkg.source,
    ...(pkg.commandSource === undefined ? {} : { commandSource: pkg.commandSource }),
    ...(pkg.scope === undefined ? {} : { scope: pkg.scope }),
    profile
  }
}

/**
 * Compare a re-listed package row with the Main-only target held by a grant.
 * IPC callers should use this before a state-changing action so a stale row
 * cannot be rebound to a different package or scope.
 */
export function matchesPackageActionTarget(
  target: PackageActionTarget,
  current: PackageInfo,
  profile: PackageManagerProfile
): boolean {
  return (
    target.profile === profile &&
    target.source === current.source &&
    target.commandSource === current.commandSource &&
    target.scope === current.scope
  )
}

/**
 * Main-owned package-row capabilities.
 *
 * A list response mints one snapshot for a renderer. Refreshing that list
 * revokes its previous ids, claims serialize one mutation at a time, and a
 * successful mutation consumes its id so the renderer must refresh before it
 * can issue another command for that row.
 */
export class PackageActionGrantManager {
  private readonly grants = new Map<string, StoredPackageActionGrant>()
  private readonly grantIdsByOwner = new Map<number, Set<string>>()
  private readonly leases = new Set<string>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: PackageActionGrantManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PACKAGE_ACTION_GRANT_TTL_MS
  }

  /**
   * Replace this renderer's previous package-list snapshot with a fresh one.
   * The returned descriptors contain no source, commandSource, scope, profile,
   * or path field even though all of those remain available in Main leases.
   */
  mintSnapshot(
    packages: readonly PackageInfo[],
    context: PackageActionGrantContext
  ): PackageActionDescriptor[] {
    this.pruneExpired()
    this.revokeOwner(context.ownerWebContentsId)

    const expiresAt = this.now() + this.ttlMs
    const ids = new Set<string>()
    const descriptors: PackageActionDescriptor[] = []

    for (const pkg of packages) {
      const id = `package-action-${crypto.randomUUID()}`
      const descriptor = descriptorFor(pkg, id)
      this.grants.set(id, {
        descriptor,
        target: targetFor(pkg, context.profile),
        ownerWebContentsId: context.ownerWebContentsId,
        expiresAt
      })
      ids.add(id)
      descriptors.push(copyDescriptor(descriptor))
    }

    if (ids.size > 0) this.grantIdsByOwner.set(context.ownerWebContentsId, ids)
    return descriptors
  }

  /**
   * Reserve a row for one Main-side mutation. A second concurrent claim for
   * the same id returns null rather than dispatching a duplicate CLI command.
   */
  claimPackageAction(id: unknown, ownerWebContentsId: number): PackageActionGrantLease | null {
    this.pruneExpired()
    if (!validGrantId(id) || this.leases.has(id)) return null
    const stored = this.grants.get(id)
    if (
      !stored ||
      stored.ownerWebContentsId !== ownerWebContentsId ||
      stored.expiresAt <= this.now()
    ) {
      return null
    }

    this.leases.add(id)
    return {
      id,
      descriptor: copyDescriptor(stored.descriptor),
      target: copyTarget(stored.target)
    }
  }

  /**
   * Complete a claimed mutation. Failures release the id for a retry; a
   * success consumes it so Main's next list snapshot is authoritative.
   */
  finishPackageAction(id: string, success: boolean): void {
    this.leases.delete(id)
    if (success) this.removeGrant(id)
  }

  /** Revoke an individual opaque descriptor, for example after revalidation fails. */
  revoke(id: unknown): boolean {
    if (!validGrantId(id) || !this.grants.has(id)) return false
    this.removeGrant(id)
    return true
  }

  /** Revoke every snapshot and in-flight lease owned by a destroyed renderer. */
  revokeOwner(ownerWebContentsId: number): void {
    const ids = this.grantIdsByOwner.get(ownerWebContentsId)
    if (!ids) return
    for (const id of [...ids]) this.removeGrant(id)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, stored] of this.grants) {
      if (stored.expiresAt <= now) this.removeGrant(id)
    }
  }

  private removeGrant(id: string): void {
    const stored = this.grants.get(id)
    this.grants.delete(id)
    this.leases.delete(id)
    if (!stored) return

    const ids = this.grantIdsByOwner.get(stored.ownerWebContentsId)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) this.grantIdsByOwner.delete(stored.ownerWebContentsId)
  }
}
