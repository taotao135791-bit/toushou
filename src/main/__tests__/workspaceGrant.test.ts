import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RecentWorkspaceRegistry, WorkspaceGrantManager } from '../workspaceGrant'
import { FsGuard } from '../fsGuard'

describe('WorkspaceGrantManager', () => {
  let base: string
  let manager: WorkspaceGrantManager

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-grant-'))
    manager = new WorkspaceGrantManager({ fsGuard: new FsGuard() })
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('mints a grant for a real directory', async () => {
    const dir = path.join(base, 'workspace')
    fs.mkdirSync(dir)
    const grant = await manager.createGrant(dir, 'dialog')
    expect(grant).not.toBeNull()
    expect(grant?.realPath).toBe(fs.realpathSync(dir))
    expect(grant?.displayPath).toBe(dir)
    expect(grant?.source).toBe('dialog')
  })

  it('rejects a non-existent path', async () => {
    const grant = await manager.createGrant(path.join(base, 'missing'), 'dialog')
    expect(grant).toBeNull()
  })

  it('rejects a file (not a directory)', async () => {
    const file = path.join(base, 'file.txt')
    fs.writeFileSync(file, 'x')
    const grant = await manager.createGrant(file, 'dialog')
    expect(grant).toBeNull()
  })

  it('allows Main to mint a grant for a validated dialog path', async () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    const grant = await manager.createGrant(outside, 'dialog')
    expect(grant).not.toBeNull()
    // The real path is canonical.
    expect(grant?.realPath).toBe(fs.realpathSync(outside))
  })

  it('reuses a grant for the same real path', async () => {
    const dir = path.join(base, 'workspace')
    fs.mkdirSync(dir)
    const g1 = await manager.createGrant(dir, 'dialog')
    const g2 = await manager.createGrant(dir, 'recent-project')
    expect(g1?.id).toBe(g2?.id)
    expect(g2?.source).toBe('recent-project')
  })

  it('registers the real path with FsGuard', async () => {
    const dir = path.join(base, 'workspace')
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    fs.symlinkSync(real, dir)
    const grant = await manager.createGrant(dir, 'dialog')
    expect(grant?.realPath).toBe(fs.realpathSync(real))
    // Files inside the real path are allowed.
    fs.writeFileSync(path.join(real, 'file.txt'), 'hello')
    expect(manager['fsGuard'].isAllowed(path.join(dir, 'file.txt'))).toBe(true)
  })

  it('revoke drops the FsGuard root', async () => {
    const dir = path.join(base, 'workspace')
    fs.mkdirSync(dir)
    const grant = await manager.createGrant(dir, 'dialog')
    expect(manager.revoke(grant!.id)).toBe(true)
    expect(manager.get(grant!.id)).toBeUndefined()
    fs.writeFileSync(path.join(dir, 'file.txt'), 'hello')
    expect(manager['fsGuard'].isAllowed(path.join(dir, 'file.txt'))).toBe(false)
  })

  it('activates a persisted recent path only through an opaque Main-issued id', async () => {
    const dir = path.join(base, 'recent')
    fs.mkdirSync(dir)
    let persisted = [dir]
    const registry = new RecentWorkspaceRegistry(manager, {
      readPaths: () => persisted,
      writePaths: (paths) => {
        persisted = paths
      }
    })
    const [descriptor] = await registry.list()
    const grant = await registry.activate(descriptor.id)
    expect(grant).not.toBeNull()
    expect(grant?.source).toBe('recent-project')
    expect(grant?.realPath).toBe(fs.realpathSync(dir))
    await expect(registry.activate(dir)).resolves.toBeNull()
  })

  it('drops deleted recent paths before activation', async () => {
    const dir = path.join(base, 'deleted')
    fs.mkdirSync(dir)
    let persisted = [dir]
    const registry = new RecentWorkspaceRegistry(manager, {
      readPaths: () => persisted,
      writePaths: (paths) => {
        persisted = paths
      }
    })
    const [descriptor] = await registry.list()
    fs.rmSync(dir, { recursive: true, force: true })
    await expect(registry.list()).resolves.toEqual([])
    await expect(registry.activate(descriptor.id)).resolves.toBeNull()
    expect(persisted).toEqual([])
  })

  it('re-canonicalizes a replaced recent path before minting a grant', async () => {
    const original = path.join(base, 'original')
    const replacement = path.join(base, 'replacement')
    const link = path.join(base, 'recent-link')
    fs.mkdirSync(original)
    fs.mkdirSync(replacement)
    fs.symlinkSync(original, link)
    let persisted = [link]
    const registry = new RecentWorkspaceRegistry(manager, {
      readPaths: () => persisted,
      writePaths: (paths) => {
        persisted = paths
      }
    })

    const [before] = await registry.list()
    expect(before.displayPath).toBe(fs.realpathSync(original))
    fs.rmSync(original, { recursive: true, force: true })
    fs.symlinkSync(replacement, original)

    const [after] = await registry.list()
    expect(after.id).not.toBe(before.id)
    expect(await registry.activate(before.id)).toBeNull()
    const grant = await registry.activate(after.id)
    expect(grant?.realPath).toBe(fs.realpathSync(replacement))
  })
})
