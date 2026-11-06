import { readFileSync, realpathSync, readlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { app } from 'electron'
import type { PackageInfo, AppSettings } from '../shared/types'
import { linkLocalPackage, listPackagesStrict } from './packages'
import { getStore, setStore } from './store'
import { beginRuntimePreparation } from './runtimePreparationGate'

export const BUNDLED_PACKAGES: readonly { name: string; resourceDir: string }[] = [
  { name: 'toushou-ads-toolkit', resourceDir: 'ads-toolkit' },
  { name: 'toushou-boards-toolkit', resourceDir: 'boards-toolkit' },
  { name: 'toushou-browser-use', resourceDir: 'browser-use-toolkit' },
  { name: 'toushou-material-research', resourceDir: 'material-research-toolkit' },
  { name: 'toushou-tiktok-toolkit', resourceDir: 'tiktok-toolkit' },
  { name: 'toushou-appsflyer-toolkit', resourceDir: 'appsflyer-toolkit' },
  { name: 'toushou-feishu-toolkit', resourceDir: 'feishu-toolkit' },
  { name: 'toushou-tasks-toolkit', resourceDir: 'tasks-toolkit' }
]

export function bundledResourcePath(resourceDir: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, resourceDir) : path.join(app.getAppPath(), 'resources', resourceDir)
}
function manifest(root: string): { name?: string; version?: string; main?: string } | null {
  try { return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) } catch { return null }
}
export function readBundledPackageVersion(resourceDir: string): string | null {
  const version = manifest(bundledResourcePath(resourceDir))?.version
  return typeof version === 'string' && version ? version : null
}
const normalized = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value)
const canonical = (value: string) => { try { return normalized(realpathSync(value)) } catch { return normalized(path.resolve(value)) } }
function installedRoot(pkg: PackageInfo): string | null {
  if (!pkg.path || !path.isAbsolute(pkg.path)) return null
  try { return normalized(realpathSync(pkg.path)) } catch {
    // A removed app may leave a broken runtime symlink. Its target is usable
    // only when it matches a previously recorded managed resource.
    try { return normalized(path.resolve(path.dirname(pkg.path), readlinkSync(pkg.path))) } catch { return null }
  }
}
function packageName(pkg: PackageInfo): string { return (pkg.path && manifest(pkg.path)?.name) || pkg.name }
function applicationResource(root: string, resourceDir: string): boolean {
  if (path.basename(root) !== resourceDir || path.basename(path.dirname(root)).toLowerCase() !== 'resources') return false
  const resources = path.dirname(root)
  // Electron fs reads inside app.asar; tests use a directory at this location.
  // Development has package.json above resources. A namesake alone is not proof.
  const owner = manifest(path.join(resources, 'app.asar')) ?? manifest(path.dirname(resources))
  return !!owner && ['toushou', 'toushou-beta'].includes(owner.name ?? '') && /^dist-electron\/main\/(?:index\.js|beta\.cjs)$/.test(owner.main ?? '')
}
export function bundledCompatibilityStamp(version: string, resourcePath: string): string {
  const hash = createHash('sha256').update(canonical(resourcePath)).digest('hex').slice(0, 16)
  // Old stable only compares this field to its manifest. A bundle-specific
  // stamp forces that old code to restore its own link after leaving Beta.
  return `${version}${version.includes('+') ? '.' : '+'}app.bundle.${hash}`
}

export type BundledPackageDecision = 'link' | 'mark' | 'skip' | 'note-removed'
export interface BundledPackageFacts {
  installed: boolean
  linkedVersion?: string
  userRemoved: boolean
  managed?: boolean
  enabled?: boolean
  currentPath?: boolean
  receiptCurrent?: boolean
}
/** Name/version equality never proves which bundle the runtime will execute. */
export function planBundledPackageAction(facts: BundledPackageFacts, bundledVersion: string | null): BundledPackageDecision {
  if (facts.userRemoved || !bundledVersion) return 'skip'
  if (!facts.installed) return facts.linkedVersion ? 'note-removed' : 'link'
  if (!facts.managed || facts.enabled === false) return 'skip'
  if (!facts.currentPath) return 'link'
  return facts.receiptCurrent ? 'skip' : 'mark'
}

export interface BundledPreparationResult { ok: boolean; failed: string[] }
let inFlight: Promise<BundledPreparationResult> | null = null
/** Share only the active attempt; unavailable CLI/link results can retry later. */
export function ensureBundledPackages(): Promise<BundledPreparationResult> {
  if (inFlight) return inFlight
  const finish = beginRuntimePreparation()
  inFlight = synchronize().catch(() => {
    console.warn('[bundled-packages] synchronization-unavailable')
    return { ok: false, failed: ['synchronization-unavailable'] }
  }).finally(() => { inFlight = null; finish() })
  return inFlight
}
async function synchronize(): Promise<BundledPreparationResult> {
  const deadline = Date.now() + 30_000
  const remaining = () => Math.max(0, deadline - Date.now())
  const failed: string[] = []
  let listed: PackageInfo[]
  try { listed = await listPackagesStrict(undefined, { timeoutMs: Math.min(20_000, remaining()) }) } catch {
    console.warn('[bundled-packages] package-list-unavailable')
    return { ok: false, failed: ['package-list-unavailable'] }
  }
  const original = getStore('bundledPackages') ?? {}
  const record: AppSettings['bundledPackages'] = { ...original }
  const linked: Array<{ pkg: typeof BUNDLED_PACKAGES[number]; version: string; target: string }> = []
  const receipt = (name: string, version: string, target: string) => {
    record[name] = { ...record[name], version: bundledCompatibilityStamp(version, target), manifestVersion: version, resourcePath: target, userRemoved: false }
  }
  for (const pkg of BUNDLED_PACKAGES) {
    if (!remaining()) { failed.push('preparation-deadline'); break }
    const target = canonical(bundledResourcePath(pkg.resourceDir)), bundled = manifest(target), version = bundled?.version
    if (bundled?.name !== pkg.name || typeof version !== 'string' || !version) continue
    const entry = record[pkg.name], matches = listed.filter(item => packageName(item) === pkg.name || item.name === pkg.name)
    // Ambiguous registrations and user-owned replacements are not ours to fix.
    if (matches.length > 1) continue
    const installed = matches[0], root = installed && installedRoot(installed)
    const currentPath = root === target
    const owned = !!root && (currentPath || !!entry && (entry.resourcePath ? canonical(entry.resourcePath) === root : applicationResource(root, pkg.resourceDir)))
    const action = planBundledPackageAction({ installed: !!installed, linkedVersion: entry?.version, userRemoved: entry?.userRemoved ?? false, managed: owned, enabled: installed?.enabled, currentPath, receiptCurrent: entry?.manifestVersion === version && entry?.resourcePath === target && entry?.version === bundledCompatibilityStamp(version, target) }, version)
    if (action === 'note-removed') record[pkg.name] = { ...entry, version: entry?.version ?? '', userRemoved: true }
    else if (action === 'mark') receipt(pkg.name, version, target)
    else if (action === 'link') {
      try {
        const result = await linkLocalPackage(target, { timeoutMs: Math.min(15_000, remaining()), preparation: true })
        if (result.ok) linked.push({ pkg, version, target })
        else { failed.push(pkg.name); console.warn(`[bundled-packages] link-failed ${pkg.name}`) }
      } catch { failed.push(pkg.name); console.warn(`[bundled-packages] link-failed ${pkg.name}`) }
    }
  }
  if (linked.length) {
    // Exit zero alone is insufficient: verify the registry's actual target.
    let verified: PackageInfo[]
    if (!remaining()) { console.warn('[bundled-packages] preparation-deadline'); return { ok: false, failed: [...failed, 'preparation-deadline'] } }
    try { verified = await listPackagesStrict(undefined, { timeoutMs: Math.min(5_000, remaining()) }) } catch {
      console.warn('[bundled-packages] link-verification-unavailable')
      return { ok: false, failed: [...failed, 'link-verification-unavailable'] }
    }
    for (const { pkg, version, target } of linked) {
      const matches = verified.filter(item => packageName(item) === pkg.name || item.name === pkg.name)
      if (matches.length === 1 && matches[0].enabled !== false && installedRoot(matches[0]) === target && manifest(target)?.version === version) receipt(pkg.name, version, target)
      else { failed.push(pkg.name); console.warn(`[bundled-packages] link-target-unverified ${pkg.name}`) }
    }
  }
  if (!isDeepStrictEqual(original, record)) setStore('bundledPackages', record)
  return { ok: failed.length === 0, failed: [...new Set(failed)] }
}
