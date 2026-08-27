import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userDataDir = ''
const packageOps = vi.hoisted(() => ({
  linkLocalPackage: vi.fn(async () => ({ ok: true, log: 'linked' })),
  removePackage: vi.fn(async () => ({ ok: true, log: 'removed' }))
}))

vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
vi.mock('../omp', () => ({ detectCli: () => ({ command: 'omp', available: true }) }))
vi.mock('../packages', () => packageOps)

import {
  deleteManagedPlugin,
  getManagedPlugin,
  listManagedPlugins,
  saveManagedPlugin,
  syncManagedPlugin,
  type ManagedPluginStorageLocations
} from '../managedPlugins'

let dir: string
let locations: ManagedPluginStorageLocations

const starterCode = 'export default function (pi: unknown) { void pi }\n'

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-gui-managed-plugin-'))
  userDataDir = dir
  locations = {
    rootDir: path.join(dir, 'managed'),
    registryPath: path.join(dir, 'managed', 'registry.json')
  }
  packageOps.linkLocalPackage.mockClear()
  packageOps.removePackage.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('managed handwritten plugins', () => {
  it('stores source under app-owned opaque-id paths and returns no path to the UI model', () => {
    const saved = saveManagedPlugin(
      {
        name: 'omp-gui-demo',
        displayName: 'Demo',
        description: 'A handwritten test plugin',
        version: '0.1.0',
        code: starterCode
      },
      locations
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.plugin).not.toHaveProperty('path')
    expect(existsSync(path.join(locations.rootDir, saved.plugin.id, 'extensions', 'index.ts'))).toBe(true)
    expect(readFileSync(locations.registryPath, 'utf-8')).not.toContain(path.join(locations.rootDir, saved.plugin.id))
    expect(getManagedPlugin(saved.plugin.id, locations)).toMatchObject({ code: starterCode })
    expect(listManagedPlugins(locations)).toEqual([expect.objectContaining({ id: saved.plugin.id, name: 'omp-gui-demo' })])
  })

  it('surfaces a corrupt registry instead of presenting handwritten plugins as empty', () => {
    const registryDir = path.dirname(locations.registryPath)
    mkdirSync(registryDir, { recursive: true })
    writeFileSync(locations.registryPath, '{not json')
    expect(() => listManagedPlugins(locations)).toThrow('Managed plugin registry is not valid JSON.')
  })

  it('writes complete OMP and pi extension declarations for the linked package', () => {
    const saved = saveManagedPlugin(
      { name: 'omp-gui-demo', description: 'test', version: '0.1.0', code: starterCode },
      locations
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const manifest = JSON.parse(
      readFileSync(path.join(locations.rootDir, saved.plugin.id, 'package.json'), 'utf-8')
    )
    expect(manifest.omp.extensions).toEqual(['extensions/index.ts'])
    expect(manifest.pi.extensions).toEqual(['extensions/index.ts'])
  })

  it('links explicitly, records sync state, then unlinks before deleting managed source', async () => {
    const saved = saveManagedPlugin(
      { name: 'omp-gui-demo', description: 'test', version: '0.1.0', code: starterCode },
      locations
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const synced = await syncManagedPlugin(saved.plugin.id, locations)
    expect(synced.ok).toBe(true)
    if (!synced.ok) return
    expect(packageOps.linkLocalPackage).toHaveBeenCalledWith(path.join(locations.rootDir, saved.plugin.id))
    expect(synced.plugin?.syncedAt).toEqual(expect.any(Number))

    const deleted = await deleteManagedPlugin(saved.plugin.id, locations)
    expect(deleted.ok).toBe(true)
    expect(packageOps.removePackage).toHaveBeenCalledWith('omp-gui-demo')
    expect(existsSync(path.join(locations.rootDir, saved.plugin.id))).toBe(false)
    expect(listManagedPlugins(locations)).toEqual([])
  })

  it('refuses a name change after a plugin has been synced, preventing an orphaned runtime link', async () => {
    const saved = saveManagedPlugin(
      { name: 'omp-gui-demo', description: 'test', version: '0.1.0', code: starterCode },
      locations
    )
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    await syncManagedPlugin(saved.plugin.id, locations)
    expect(
      saveManagedPlugin(
        {
          id: saved.plugin.id,
          name: 'a-different-name',
          description: 'test',
          version: '0.1.0',
          code: starterCode
        },
        locations
      )
    ).toEqual({
      ok: false,
      error: 'A synced plugin keeps its package name. Create a new plugin to use a different name.'
    })
  })
})
