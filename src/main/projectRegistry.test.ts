import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectRegistry, isFilesystemRoot, type ProjectRegistryOptions } from './projectRegistry'
import { isProjectDeletionInProgress } from './projectDeletionGate'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(identify?: ProjectRegistryOptions['identify']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-registry-test-')); roots.push(root)
  const fallback = path.join(root, 'default'); const project = path.join(root, 'project')
  fs.mkdirSync(fallback); fs.mkdirSync(project)
  const confirm = vi.fn(async () => true); const trash = vi.fn(async (_file: string) => {})
  const close = vi.fn(async () => true); const discover = vi.fn(async (_file: string) => [] as Array<{path: string;dev:number;ino:number}>)
  let busy = false
  const options: ProjectRegistryOptions = { file: path.join(root, 'data', 'projects.json'), defaultPath: fallback, protectedPaths: [root], recentPaths: () => [], isBusy: () => busy, confirmDelete: confirm, trash, discoverSessions: discover, closeIdleSessions: close, identify }
  const registry = new ProjectRegistry(options)
  return { root, project, fallback, registry, options, confirm, trash, close, discover, setBusy: (b: boolean) => { busy = b } }
}
function remountIdentity() {
  let devDelta = 0
  let volumeId = '00000000-0000-0000-0000-000000000001'
  let birthDelta = 0
  const identify: NonNullable<ProjectRegistryOptions['identify']> = target => {
    const canonical = fs.realpathSync.native(target), st = fs.lstatSync(canonical)
    return { path: canonical, dev: st.dev + devDelta, ino: st.ino, volumeId, birthtimeMs: st.birthtimeMs + birthDelta }
  }
  return { identify, remount: () => { devDelta++ }, replaceVolume: () => { volumeId = '00000000-0000-0000-0000-000000000002' }, reuseInode: () => { birthDelta++ } }
}
describe('project lifecycle', () => {
  it('retains project and default identities after a remount and process restart', () => {
    const identity = remountIdentity(), f = fixture(identity.identify)
    const registered = f.registry.register(f.project); if (!registered.ok) throw new Error('fixture')
    const defaultId = f.registry.list().find(p => p.isDefault)!.id
    identity.remount()
    const restarted = new ProjectRegistry(f.options)
    expect(restarted.get(registered.project.id)).toMatchObject({ id: registered.project.id, missing: false })
    expect(restarted.get(defaultId)).toMatchObject({ missing: false })
  })
  it('requires confirmation for a changed volume or reused inode even at the same path', () => {
    const identity = remountIdentity(), f = fixture(identity.identify)
    const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    identity.replaceVolume()
    expect(f.registry.get(p.project.id)).toMatchObject({ missing: true, unavailableReason: 'identity-changed' })
    expect(f.registry.recover(p.project.id, f.project)).toMatchObject({ ok: true, project: { id: p.project.id, missing: false } })
    identity.reuseInode()
    expect(f.registry.get(p.project.id)).toMatchObject({ missing: true, unavailableReason: 'identity-changed' })
  })
  it('migrates a matching legacy identity but requires same-path recovery after legacy device drift', () => {
    const identity = remountIdentity(), f = fixture(identity.identify)
    const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    const stripIdentity = () => {
      const store = JSON.parse(fs.readFileSync(f.options.file, 'utf8'))
      for (const item of store.projects) { delete item.volumeId; delete item.birthtimeMs }
      fs.writeFileSync(f.options.file, JSON.stringify(store))
    }
    stripIdentity()
    expect(f.registry.get(p.project.id)?.missing).toBe(false)
    expect(JSON.parse(fs.readFileSync(f.options.file, 'utf8')).projects.find((item: { id: string }) => item.id === p.project.id).volumeId).toBeTruthy()
    stripIdentity(); identity.remount()
    expect(f.registry.get(p.project.id)).toMatchObject({ missing: true, unavailableReason: 'identity-changed' })
    expect(f.registry.recover(p.project.id, f.fallback)).toMatchObject({ ok: false, error: 'wrong-folder' })
    expect(f.registry.list()).toHaveLength(2)
    expect(f.registry.recover(p.project.id, f.project)).toMatchObject({ ok: true, project: { id: p.project.id, missing: false } })
    identity.remount()
    expect(new ProjectRegistry(f.options).get(p.project.id)?.missing).toBe(false)
  })
  it('keeps strict device validation on filesystems without a persistent volume ID', () => {
    const identity = remountIdentity()
    const f = fixture((target, force) => ({ ...identity.identify(target, force), volumeId: null }))
    const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    identity.remount()
    expect(f.registry.get(p.project.id)?.unavailableReason).toBe('identity-changed')
  })
  it('blocks deletion if a mount changes while the native confirmation is open', async () => {
    const identity = remountIdentity(), f = fixture(identity.identify)
    const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    f.confirm.mockImplementationOnce(async () => { identity.remount(); return true })
    expect(await f.registry.delete(p.project.id)).toMatchObject({ ok: false, error: 'path-changed' })
    expect(f.trash).not.toHaveBeenCalled()
  })
  it('protects filesystem roots including other drives and UNC shares on any test platform', () => {
    expect(isFilesystemRoot('/', path.posix)).toBe(true)
    expect(isFilesystemRoot('/tmp/project', path.posix)).toBe(false)
    expect(isFilesystemRoot('D:\\', path.win32)).toBe(true)
    expect(isFilesystemRoot('d:\\project', path.win32)).toBe(false)
    expect(isFilesystemRoot('\\\\server\\share', path.win32)).toBe(true)
    expect(isFilesystemRoot('\\\\server\\share\\project', path.win32)).toBe(false)
    expect(isFilesystemRoot('\\\\?\\D:\\', path.win32)).toBe(true)
    expect(isFilesystemRoot('\\\\?\\UNC\\server\\share\\', path.win32)).toBe(true)
    expect(isFilesystemRoot('\\\\?\\UNC\\server\\share\\project', path.win32)).toBe(false)
  })
  it('rejects an actual registered filesystem root before confirmation or trash', async () => {
    const f = fixture(); const root = f.registry.register(path.parse(f.project).root)
    if (!root.ok) throw new Error('fixture')
    expect(await f.registry.delete(root.project.id)).toMatchObject({ok:false,error:'protected'})
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.trash).not.toHaveBeenCalled()
  })
  it('retains stable identity across archive, restore, restart and a missing path', () => {
    const f = fixture(); const result = f.registry.register(f.project); expect(result.ok).toBe(true); if (!result.ok) return
    const id = result.project.id
    expect(f.registry.setArchived(id, true)).toMatchObject({ ok: true, project: { id, archived: true } })
    expect(f.registry.setArchived(id, false)).toMatchObject({ ok: true, project: { id, archived: false } })
    fs.renameSync(f.project, `${f.project}-moved`)
    expect(f.registry.get(id)).toMatchObject({ id, missing: true })
    fs.renameSync(`${f.project}-moved`, f.project)
    expect(f.registry.get(id)).toMatchObject({ id, missing: false })
  })
  it('recreates a missing managed default without accepting a symlink replacement', () => {
    const f = fixture(); const initial = f.registry.list().find(project => project.isDefault)!
    fs.renameSync(f.fallback, `${f.fallback}-old`)
    expect(f.registry.get(initial.id)).toMatchObject({id:initial.id, missing:false, isDefault:true})
    fs.rmSync(f.fallback, {recursive:true}); fs.symlinkSync(`${f.fallback}-old`, f.fallback, process.platform === 'win32' ? 'junction' : 'dir')
    expect(f.registry.get(initial.id)).toMatchObject({id:initial.id, missing:true})
  })
  it('protects default, nested registered projects and changed directory identity', async () => {
    const f = fixture(); const def = f.registry.list().find(p => p.isDefault)!
    expect(await f.registry.delete(def.id)).toMatchObject({ ok: false, error: 'protected' })
    const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    fs.mkdirSync(path.join(f.project, 'nested')); f.registry.register(path.join(f.project, 'nested'))
    expect(await f.registry.delete(p.project.id)).toMatchObject({ ok: false, error: 'protected' })
    const other = path.join(f.root, 'other'); fs.mkdirSync(other); const o = f.registry.register(other); if (!o.ok) throw new Error('fixture')
    fs.renameSync(other, `${other}-original`); fs.symlinkSync(`${other}-original`, other, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.registry.delete(o.project.id)).toMatchObject({ ok: false, error: 'path-changed' })
    expect(f.trash).not.toHaveBeenCalled()
  })
  it('holds the lock during confirmation and refuses newly busy sessions or a failed exit', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    let respond!: (v: boolean) => void
    f.confirm.mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
    const pending = f.registry.delete(p.project.id)
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
    expect(isProjectDeletionInProgress(f.project)).toBe(true)
    f.setBusy(true); expect(f.registry.setArchived(p.project.id, true)).toMatchObject({ ok: false, error: 'busy' }); respond(true)
    expect(await pending).toMatchObject({ ok: false, error: 'busy' })
    expect(isProjectDeletionInProgress(f.project)).toBe(false)
    f.setBusy(false); f.close.mockResolvedValueOnce(false)
    expect(await f.registry.delete(p.project.id)).toMatchObject({ ok: false, error: 'busy' })
    expect(f.trash).not.toHaveBeenCalled()
  })
  it('rejects registering an unregistered nested folder while deletion is awaiting trash', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested)
    let resume!: () => void
    f.trash.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve }))
    const pending = f.registry.delete(p.project.id)
    await vi.waitFor(() => expect(f.trash).toHaveBeenCalledOnce())
    expect(f.registry.register(nested)).toMatchObject({ok:false,error:'busy'})
    expect(f.registry.list().some(project => project.path === fs.realpathSync.native(nested))).toBe(false)
    resume()
    expect(await pending).toMatchObject({ok:true})
  })
  it('does not close or move anything when confirmation is cancelled', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    f.confirm.mockResolvedValueOnce(false)
    expect(await f.registry.delete(p.project.id)).toMatchObject({ok:false,error:'cancelled'})
    expect(f.close).not.toHaveBeenCalled(); expect(f.trash).not.toHaveBeenCalled()
  })
  it('refuses changes to the transcript set while the confirmation is open', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    f.discover.mockResolvedValueOnce([]).mockResolvedValueOnce([{path:'/synthetic/new', dev:1, ino:1}])
    expect(await f.registry.delete(p.project.id)).toMatchObject({ok:false,error:'path-changed'})
    expect(f.trash).not.toHaveBeenCalled()
  })
  it('confirms then trashes verified transcripts before the project and removes the record', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    const file = path.join(fs.realpathSync.native(f.root), 'session.jsonl'); fs.writeFileSync(file, '{}'); const stat = fs.statSync(file)
    f.discover.mockResolvedValue([{ path: file, dev: stat.dev, ino: stat.ino }])
    f.trash.mockImplementation(async target => { fs.renameSync(target, `${target}.trashed`) })
    const result = await f.registry.delete(p.project.id)
    expect(result.ok).toBe(true)
    expect(f.confirm).toHaveBeenCalledWith(p.project.path, 1)
    expect(f.trash.mock.calls.map(([target]) => target)).toEqual([file, p.project.path])
    expect(f.registry.get(p.project.id)).toBeNull()
  })
  it('refuses archive of a busy project without losing it', () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    f.setBusy(true)
    expect(f.registry.setArchived(p.project.id, true)).toMatchObject({ok:false,error:'busy'})
    expect(f.registry.get(p.project.id)).toMatchObject({archived:false})
  })
  it('checks the session manifest twice and keeps the registry after a partial trash failure', async () => {
    const f = fixture(); const p = f.registry.register(f.project); if (!p.ok) throw new Error('fixture')
    const file = path.join(fs.realpathSync.native(f.root), 'synthetic.jsonl'); fs.writeFileSync(file, '{}'); const stat = fs.statSync(file)
    f.discover.mockResolvedValue([{ path: file, dev: stat.dev, ino: stat.ino }])
    f.trash.mockRejectedValueOnce(new Error('fake trash failure'))
    expect(await f.registry.delete(p.project.id)).toMatchObject({ ok: false, error: 'partial-failure' })
    expect(f.registry.get(p.project.id)).not.toBeNull()
    expect(f.trash).toHaveBeenCalledTimes(1)
  })
})
