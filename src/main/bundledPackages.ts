import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { linkLocalPackage, listPackages } from './packages'
import { getStore, setStore } from './store'

/**
 * Packages shipped in the app bundle and linked into the runtime on first
 * run, so a fresh install exposes them without user action. Linking (not
 * installing) keeps the package at its read-only bundle path; `omp plugin
 * link` is the same primitive the plugins page uses for local sources.
 *
 * Removal is respected: once the app sees its own link gone from the
 * runtime's package list, it records userRemoved and never re-adds the
 * package automatically.
 */

export const BUNDLED_PACKAGES: readonly { name: string; resourceDir: string }[] = [
  { name: 'toushou-ads-toolkit', resourceDir: 'ads-toolkit' }
]

export function bundledResourcePath(resourceDir: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, resourceDir)
    : path.join(app.getAppPath(), 'resources', resourceDir)
}

/** Version from the bundled package manifest, or null when unreadable. */
export function readBundledPackageVersion(resourceDir: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(bundledResourcePath(resourceDir), 'package.json'), 'utf-8')
    ) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : null
  } catch {
    return null
  }
}

export type BundledPackageDecision = 'link' | 'mark' | 'skip' | 'note-removed'

export interface BundledPackageFacts {
  /** The runtime currently lists a package with this name. */
  installed: boolean
  /** Version this app linked successfully last (undefined = never linked). */
  linkedVersion?: string
  /** The user removed the app-managed link; never re-add automatically. */
  userRemoved: boolean
}

/**
 * Pure decision for one bundled package:
 * - link:         never linked, runtime lists nothing under this name
 * - mark:         present under this name but our version stamp is stale
 *                 (app upgrade bumped the bundled version) — stamp only
 * - note-removed: we linked before but the runtime no longer lists the
 *                 package — the user removed it; record and stay silent
 * - skip:         up to date, user-removed, or the bundle is unreadable
 */
export function planBundledPackageAction(
  facts: BundledPackageFacts,
  bundledVersion: string | null
): BundledPackageDecision {
  if (facts.userRemoved) return 'skip'
  if (!bundledVersion) return 'skip'
  if (facts.installed) {
    return facts.linkedVersion === bundledVersion ? 'skip' : 'mark'
  }
  return facts.linkedVersion ? 'note-removed' : 'link'
}

/** Idempotent, best-effort: safe to call on every startup. */
export async function ensureBundledPackages(): Promise<void> {
  const installedNames = new Set(
    (await listPackages().catch(() => [])).map((pkg) => pkg.name)
  )
  const record: Record<string, { version: string; userRemoved: boolean }> = {
    ...(getStore('bundledPackages') ?? {})
  }

  for (const pkg of BUNDLED_PACKAGES) {
    const version = readBundledPackageVersion(pkg.resourceDir)
    const entry = record[pkg.name]
    const action = planBundledPackageAction(
      {
        installed: installedNames.has(pkg.name),
        linkedVersion: entry?.version,
        userRemoved: entry?.userRemoved ?? false
      },
      version
    )

    // Non-skip decisions imply a readable bundled version (see the planner).
    if (!version || action === 'skip') continue

    if (action === 'link') {
      const result = await linkLocalPackage(bundledResourcePath(pkg.resourceDir))
      // A failed link writes no record, so the next launch retries.
      if (result.ok) record[pkg.name] = { version, userRemoved: false }
    } else if (action === 'mark') {
      record[pkg.name] = { version, userRemoved: false }
    } else if (action === 'note-removed') {
      record[pkg.name] = { version: entry?.version ?? '', userRemoved: true }
    }
  }

  setStore('bundledPackages', record)
}
