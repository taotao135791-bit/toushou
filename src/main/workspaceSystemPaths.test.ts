import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const fake = vi.hoisted(() => ({ paths: {} as Record<string, string>, missing: new Set<string>() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => {
  if (fake.missing.has(name)) throw new Error(`Failed to get '${name}' path`)
  return fake.paths[name] ?? ''
} } }))
import { getWorkspaceSystemPaths, projectSystemPathsError, resetWorkspaceSystemPathsForTest, resolveWorkspaceSystemPaths } from './workspaceSystemPaths'
import { ProjectRegistry } from './projectRegistry'

const home = path.resolve('/synthetic/home')
const userData = path.join(home, 'app-data')
const docs = path.join(home, 'Documents')
const desktop = path.join(home, 'Desktop')
const downloads = path.join(home, 'Downloads')
beforeEach(() => {
  fake.paths = {home, userData, documents:docs, desktop, downloads}
  fake.missing = new Set()
  resetWorkspaceSystemPathsForTest()
})

describe('workspace system paths', () => {
  it('starts with a missing Desktop and Downloads while refusing uncertain project deletion', () => {
    fake.missing = new Set(['desktop', 'downloads'])
    const result = getWorkspaceSystemPaths()
    expect(result.defaultWorkspace).toBe(path.join(docs, '投手工作区'))
    expect(result.protectedPaths).toEqual(expect.arrayContaining([home, userData, docs, desktop, downloads]))
    expect(result.deletionProtectionComplete).toBe(false)
    expect(projectSystemPathsError(result)).toBe('system-paths-unavailable')
    expect(getWorkspaceSystemPaths()).toBe(result)
  })
  it('uses one stable fallback workspace when Documents is unavailable', () => {
    fake.missing = new Set(['documents'])
    const result = getWorkspaceSystemPaths()
    expect(result.documents).toBe(docs)
    expect(result.defaultWorkspace).toBe(path.join(docs, '投手工作区'))
    expect(result.protectedPaths).toContain(docs)
    expect(result.deletionProtectionComplete).toBe(false)
    fake.missing.clear()
    expect(getWorkspaceSystemPaths()).toBe(result)
  })
  it('protects both known redirected paths and conventional locations', () => {
    const external = path.resolve('/synthetic/redirected')
    fake.paths.documents = path.join(external, 'docs')
    fake.paths.desktop = path.join(external, 'desktop')
    fake.paths.downloads = path.join(external, 'downloads')
    const result = resolveWorkspaceSystemPaths(name => fake.paths[name], () => home)
    expect(result.defaultWorkspace).toBe(path.join(external, 'docs', '投手工作区'))
    expect(result.protectedPaths).toEqual(expect.arrayContaining([home, docs, desktop, downloads, fake.paths.documents, fake.paths.desktop, fake.paths.downloads]))
    expect(result.deletionProtectionComplete).toBe(true)
    expect(projectSystemPathsError(result)).toBeNull()
  })
  it('keeps redirected and conventional system directories protected from deletion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-paths-'))
    try {
      const fixtureHome = path.join(root, 'home'); const redirected = path.join(root, 'redirected')
      const data = path.join(root, 'app-data'); fs.mkdirSync(fixtureHome); fs.mkdirSync(redirected); fs.mkdirSync(data)
      const fixture = { home:fixtureHome, userData:data, documents:path.join(redirected,'docs'), desktop:path.join(redirected,'desktop'), downloads:path.join(redirected,'downloads') }
      for (const dir of [fixture.documents, fixture.desktop, fixture.downloads, path.join(fixtureHome,'Desktop'),path.join(fixtureHome,'Downloads')]) fs.mkdirSync(dir)
      const paths = resolveWorkspaceSystemPaths(name => fixture[name], () => fixtureHome)
      const trash = vi.fn(async () => {})
      const registry = new ProjectRegistry({ file:path.join(data,'projects.json'), defaultPath:paths.defaultWorkspace, protectedPaths:paths.protectedPaths, recentPaths:()=>[], isBusy:()=>false, confirmDelete:async()=>true, discoverSessions:async()=>[], closeIdleSessions:async()=>true, trash })
      for (const dir of [fixture.documents, fixture.desktop, fixture.downloads, path.join(fixtureHome,'Desktop'), path.join(fixtureHome,'Downloads')]) {
        const result = registry.register(dir)
        if (!result.ok) throw new Error('fixture registration failed')
        expect(await registry.delete(result.project.id)).toMatchObject({ok:false,error:'protected'})
      }
      expect(trash).not.toHaveBeenCalled()
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
  })
  it('rejects filesystem roots as system locations without creating a cwd workspace', () => {
    const root = path.parse(home).root
    const unavailable = resolveWorkspaceSystemPaths(() => root, () => root)
    expect(unavailable.defaultWorkspace).toBe('')
    expect(unavailable.documents).toBe('')
    expect(unavailable.downloads).toBe('')
    expect(projectSystemPathsError(unavailable)).toBe('system-paths-unavailable')
    const malformed = resolveWorkspaceSystemPaths(() => `${home}\0invalid`, () => '')
    expect(malformed.defaultWorkspace).toBe('')
    expect(projectSystemPathsError(malformed)).toBe('system-paths-unavailable')
  })
  it('refuses registry operations without touching files when the default workspace is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-no-default-'))
    try {
      const file = path.join(root, 'registry.json')
      const registry = new ProjectRegistry({file, defaultPath:'', protectedPaths:[], recentPaths:()=>[], isBusy:()=>false, confirmDelete:async()=>true, discoverSessions:async()=>[], closeIdleSessions:async()=>true, trash:async()=>{}})
      expect(() => registry.list()).toThrow('default-workspace-unavailable')
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.readdirSync(root)).toEqual([])
    } finally { fs.rmSync(root,{recursive:true,force:true}) }
  })
  it('uses OS home when the native home cannot be read and fails closed without any trusted home', () => {
    fake.missing = new Set(['home', 'documents', 'desktop', 'downloads'])
    const read = (name: keyof typeof fake.paths) => { if (fake.missing.has(name)) throw new Error('unavailable'); return fake.paths[name] }
    const fallback = resolveWorkspaceSystemPaths(read, () => home)
    expect(fallback.defaultWorkspace).toBe(path.join(home, 'Documents', '投手工作区'))
    expect(fallback.deletionProtectionComplete).toBe(false)
    const unknown = resolveWorkspaceSystemPaths(read, () => '')
    expect(unknown.defaultWorkspace).toBe('')
    expect(unknown.downloads).toBe('')
    expect(unknown.deletionProtectionComplete).toBe(false)
  })
})
