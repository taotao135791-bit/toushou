import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppSettings, PackageInfo } from '../../shared/types'

const state = vi.hoisted(() => ({ appRoot: '', packaged: false }))
vi.mock('../packages', () => ({ listPackagesStrict: vi.fn(), linkLocalPackage: vi.fn() }))
vi.mock('../store', () => ({ getStore: vi.fn(), setStore: vi.fn() }))
vi.mock('electron', () => ({ app: { get isPackaged() { return state.packaged }, getAppPath: () => state.appRoot, getPath: () => './' } }))
import { listPackagesStrict, linkLocalPackage } from '../packages'
import { getStore, setStore } from '../store'
import { BUNDLED_PACKAGES, bundledCompatibilityStamp, bundledResourcePath, ensureBundledPackages, planBundledPackageAction, readBundledPackageVersion } from '../bundledPackages'
import { isRuntimePreparing } from '../runtimePreparationGate'

const mockList = vi.mocked(listPackagesStrict), mockLink = vi.mocked(linkLocalPackage), mockGet = vi.mocked(getStore), mockSet = vi.mocked(setStore)
const first = BUNDLED_PACKAGES[0]
let fixture: string, registry: PackageInfo[], receipts: AppSettings['bundledPackages']
const row = (root: string, enabled = true, name = first.name): PackageInfo => ({ name, source: `omp:npm:user:${first.name}`, commandSource: first.name, kind: 'npm', path: root, enabled, resources: [], pinned: false })
function appRoot(label: string): string {
  const root = path.join(fixture, label)
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'toushou', main: 'dist-electron/main/index.js' }))
  for (const pkg of BUNDLED_PACKAGES) {
    const folder = path.join(root, 'resources', pkg.resourceDir)
    mkdirSync(folder, { recursive: true })
    const actual = JSON.parse(readFileSync(path.join(process.cwd(), 'resources', pkg.resourceDir, 'package.json'), 'utf8'))
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify(actual))
  }
  return realpathSync(root)
}
beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'bundled-managed-test-'))
  state.appRoot = appRoot('beta'); state.packaged = false
  registry = []
  receipts = Object.fromEntries(BUNDLED_PACKAGES.slice(1).map(pkg => [pkg.name, { version: 'kept-user-choice', userRemoved: true }]))
  mockList.mockReset().mockImplementation(async () => registry)
  mockGet.mockReset().mockImplementation(() => receipts as never)
  mockSet.mockReset().mockImplementation((_key, value) => { receipts = structuredClone(value) as AppSettings['bundledPackages'] })
  mockLink.mockReset().mockImplementation(async root => { registry = [row(root)]; return { ok: true, log: '' } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); state.appRoot = process.cwd(); rmSync(fixture, { recursive: true, force: true }) })

describe('managed package preparation', () => {
  it('requires actual managed/current roots rather than trusting a name and version', () => {
    expect(planBundledPackageAction({ installed: false, userRemoved: false }, '1')).toBe('link')
    expect(planBundledPackageAction({ installed: true, userRemoved: false, linkedVersion: '1' }, '1')).toBe('skip')
    expect(planBundledPackageAction({ installed: true, managed: true, userRemoved: false, currentPath: false }, '1')).toBe('link')
    expect(planBundledPackageAction({ installed: true, managed: true, currentPath: true, receiptCurrent: true, userRemoved: false }, '1')).toBe('skip')
    expect(planBundledPackageAction({ installed: true, managed: true, currentPath: true, userRemoved: false }, '1')).toBe('mark')
    expect(planBundledPackageAction({ installed: false, linkedVersion: '1', userRemoved: false }, '1')).toBe('note-removed')
    expect(planBundledPackageAction({ installed: true, managed: true, enabled: false, userRemoved: false }, '1')).toBe('skip')
    expect(planBundledPackageAction({ installed: false, userRemoved: true }, '1')).toBe('skip')
    expect(planBundledPackageAction({ installed: false, userRemoved: false }, null)).toBe('skip')
  })
  it('links and verifies a fresh package, then does no redundant relink', async () => {
    expect(await ensureBundledPackages()).toEqual({ ok: true, failed: [] })
    const target = bundledResourcePath(first.resourceDir), version = readBundledPackageVersion(first.resourceDir)!
    expect(receipts[first.name]).toEqual({ version: bundledCompatibilityStamp(version, target), manifestVersion: version, resourcePath: target, userRemoved: false })
    expect(mockList).toHaveBeenCalledTimes(2)
    mockLink.mockClear()
    await ensureBundledPackages()
    expect(mockLink).not.toHaveBeenCalled()
  })
  it('restores the correct roots across same-version Beta → actual legacy-stable algorithm → Beta', async () => {
    const stable = appRoot('stable'), stableTarget = path.join(stable, 'resources', first.resourceDir)
    const version = readBundledPackageVersion(first.resourceDir)!
    receipts[first.name] = { version, userRemoved: false }
    registry = [row(stableTarget)]
    await ensureBundledPackages()
    const beta = bundledResourcePath(first.resourceDir)
    expect(registry[0].path).toBe(beta)
    // These are the old stable 2.3.1 branches: installed name + stamp mismatch,
    // then re-link and overwrite the receipt with only plain version/removal.
    expect(receipts[first.name].version).not.toBe(version)
    if (registry.some(pkg => pkg.name === first.name) && receipts[first.name].version !== version) {
      await mockLink(stableTarget)
      receipts[first.name] = { version, userRemoved: false }
    }
    expect(registry[0].path).toBe(stableTarget)
    await ensureBundledPackages()
    expect(registry[0].path).toBe(beta)
    expect(receipts[first.name].manifestVersion).toBe(version)
  })
  it('recognizes legacy Pi display names from the actual package manifest', async () => {
    const stable = appRoot('stable')
    registry = [row(path.join(stable, 'resources', first.resourceDir), true, 'Synthetic translated display name')]
    receipts[first.name] = { version: readBundledPackageVersion(first.resourceDir)!, userRemoved: false }
    await ensureBundledPackages()
    expect(mockLink).toHaveBeenCalledWith(bundledResourcePath(first.resourceDir), expect.any(Object))
    expect(receipts[first.name].userRemoved).toBe(false)
  })
  it('preserves namesakes even when an old app receipt exists', async () => {
    const foreign = path.join(fixture, 'user-plugin')
    mkdirSync(foreign); writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: first.name, version: '999' }))
    registry = [row(foreign)]
    receipts[first.name] = { version: 'old-managed-version', userRemoved: false }
    await ensureBundledPackages()
    expect(mockLink).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })
  it('preserves disabled packages and explicit user removals without changing receipts', async () => {
    const stable = appRoot('stable')
    registry = [row(path.join(stable, 'resources', first.resourceDir), false)]
    receipts[first.name] = { version: 'previous', userRemoved: false }
    await ensureBundledPackages()
    expect(mockLink).not.toHaveBeenCalled(); expect(mockSet).not.toHaveBeenCalled()
    registry = []
    receipts[first.name].userRemoved = true
    await ensureBundledPackages()
    expect(mockLink).not.toHaveBeenCalled(); expect(mockSet).not.toHaveBeenCalled()
  })
  it('notes removal only after an authoritative successful list and retries unavailable probes', async () => {
    receipts[first.name] = { version: 'previous', userRemoved: false }
    mockList.mockRejectedValueOnce(new Error('private CLI error'))
    expect(await ensureBundledPackages()).toMatchObject({ ok: false })
    expect(mockSet).not.toHaveBeenCalled()
    await ensureBundledPackages()
    expect(receipts[first.name].userRemoved).toBe(true)
  })
  it('never upgrades a receipt on failed links, false-success targets, or failed verification', async () => {
    mockLink.mockResolvedValueOnce({ ok: false, log: 'private upstream error' })
    expect(await ensureBundledPackages()).toMatchObject({ ok: false })
    expect(receipts[first.name]).toBeUndefined()
    mockLink.mockResolvedValueOnce({ ok: true, log: '' })
    expect(await ensureBundledPackages()).toMatchObject({ ok: false })
    expect(receipts[first.name]).toBeUndefined()
    mockList.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('unavailable'))
    expect(await ensureBundledPackages()).toMatchObject({ ok: false })
    expect(receipts[first.name]).toBeUndefined()
  })
  it('shares in-flight work and stops at a real 30 second preparation budget', async () => {
    vi.useFakeTimers()
    delete receipts[BUNDLED_PACKAGES[1].name]
    let release!: () => void
    mockList.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
    const firstCall = ensureBundledPackages(), secondCall = ensureBundledPackages()
    expect(secondCall).toBe(firstCall); expect(isRuntimePreparing()).toBe(true)
    release()
    mockLink.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 15_000)); return { ok: false, log: '' } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await firstCall).toMatchObject({ ok: false })
    expect(mockLink).toHaveBeenCalledTimes(2)
    expect(mockLink.mock.calls.every(call => call[1]!.timeoutMs! <= 15_000)).toBe(true)
    expect(isRuntimePreparing()).toBe(false)
    expect(mockSet).not.toHaveBeenCalled()
  })
  it('resolves runtime symlinks before comparing with the managed bundle root', async () => {
    const target = bundledResourcePath(first.resourceDir), alias = path.join(fixture, 'linked-plugin')
    symlinkSync(target, alias, 'junction')
    registry = [row(alias)]
    await ensureBundledPackages()
    expect(mockLink).not.toHaveBeenCalled()
    expect(receipts[first.name].resourcePath).toBe(target)
  })
})

describe('packaged toolkit resource layout', () => {
  it('registers the AppsFlyer read-only toolkit for fresh installs', () => {
    expect(BUNDLED_PACKAGES).toContainEqual({ name: 'toushou-appsflyer-toolkit', resourceDir: 'appsflyer-toolkit' })
    expect(readBundledPackageVersion('appsflyer-toolkit')).toBe('0.2.0')
  })

  it('places every registered toolkit at the external path used by the runtime', async () => {
    const { mkdtempSync, cpSync, readFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { app } = await import('electron')
    const fixture = mkdtempSync(path.join(tmpdir(), 'toushou-bundled-layout-'))
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    const packaged = app.isPackaged
    try {
      const config = JSON.parse(readFileSync(path.join(process.cwd(), 'electron-builder.json'), 'utf8')) as { extraResources: Array<{ from: string; to: string }> }
      for (const pkg of BUNDLED_PACKAGES) {
        const mapping = config.extraResources.find((entry) => entry.from === `resources/${pkg.resourceDir}` && entry.to === pkg.resourceDir)
        expect(mapping, `missing external resource mapping for ${pkg.name}`).toBeDefined()
        cpSync(path.join(process.cwd(), mapping!.from), path.join(fixture, mapping!.to), { recursive: true })
      }
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: fixture })
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      for (const pkg of BUNDLED_PACKAGES) {
        expect(readBundledPackageVersion(pkg.resourceDir), `unreadable packaged ${pkg.name}`).toBeTruthy()
        const manifest = JSON.parse(readFileSync(path.join(fixture, pkg.resourceDir, 'package.json'), 'utf8')) as { omp?: { extensions?: string[] } }
        for (const extension of manifest.omp?.extensions ?? []) expect(existsSync(path.join(fixture, pkg.resourceDir, extension))).toBe(true)
      }
    } finally {
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: packaged })
      if (original) Object.defineProperty(process, 'resourcesPath', original)
      else Reflect.deleteProperty(process, 'resourcesPath')
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
