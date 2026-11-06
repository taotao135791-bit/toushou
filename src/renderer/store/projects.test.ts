import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRecord, ProjectResult, Session, WorkspaceGrant } from '@shared/types'
import { useProjects } from './projects'
import { useAppStore } from './index'
import { beginNavigationIntent, currentNavigationIntent } from '../lib/navigationIntent'

const project = (id: string, isDefault = false): ProjectRecord => ({ id, name: id, path: `/synthetic/${id}`, isDefault, missing: false, archived: false, createdAt: 1 })
const base = project('default', true)
const alpha = project('alpha')
const beta = project('beta')
const grant = (p: ProjectRecord): WorkspaceGrant => ({ id: `grant-${p.id}`, realPath: p.path, displayPath: p.path, source: p.isDefault ? 'default' : 'dialog', createdAt: 1 })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let rows: ProjectRecord[]
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  rows = [base, alpha, beta].map(item => ({ ...item }))
  api = {
    listProjects: vi.fn(async () => rows.map(item => ({ ...item }))),
    listRecentWorkspaces: vi.fn(async () => []),
    listAllSessionHistory: vi.fn(async () => []),
    setStore: vi.fn(),
    activateProject: vi.fn(async (id: string) => { const p = rows.find(item => item.id === id)!; return { ok: true, project: p, grant: grant(p) } }),
    createProject: vi.fn(async () => ({ ok: true, project: alpha, grant: grant(alpha) })),
    recoverProject: vi.fn(async () => ({ ok: true, project: alpha, grant: grant(alpha) })),
    archiveProject: vi.fn(async () => ({ ok: true, project: alpha })),
    deleteProject: vi.fn(async () => ({ ok: false, error: 'cancelled' }))
  }
  vi.stubGlobal('window', { electronAPI: api })
  useProjects.setState({ projects: rows, loaded: true, loading: false, pending: null, error: null, errorProjectId: null })
  useAppStore.setState({ currentWorkspace: grant(alpha), currentSessionId: null, sessions: [], sessionRecords: [], globalHistory: [], messages: {}, busy: {}, queuedMessages: {}, pinnedSessionIds: [], unreadSessionIds: {}, composerDrafts: {}, recentProjects: [] })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('project controller races and recovery', () => {
  it('clears a stale folder error after a successful refresh confirms the same project is available', async () => {
    useProjects.setState({ error: 'missing', errorProjectId: alpha.id, projects: rows.map(item => item.id === alpha.id ? { ...item, missing: true } : item) })
    await useProjects.getState().refresh()
    expect(useProjects.getState().error).toBeNull()
    expect(useProjects.getState().errorProjectId).toBeNull()
    expect(useProjects.getState().projects.find(item => item.id === alpha.id)?.missing).toBe(false)
  })

  it('keeps an unavailable project error scoped to that project until it recovers', async () => {
    rows = rows.map(item => item.id === alpha.id ? { ...item, missing: true } : item)
    useProjects.setState({ error: 'missing', errorProjectId: alpha.id })
    await useProjects.getState().refresh()
    expect(useProjects.getState().error).toBe('missing')
    expect(useProjects.getState().errorProjectId).toBe(alpha.id)
  })

  it('reconnects by project ID and keeps the current project conversation and draft', async () => {
    useAppStore.setState({ currentSessionId: 'alpha-session', sessions: [{ id: 'alpha-session', cwd: alpha.path, title: 'Synthetic', status: 'idle', createdAt: 1 }], composerDrafts: { 'alpha-session': { text: 'Unsent draft', images: [] } } })
    expect(await useProjects.getState().recover(alpha.id)).toBe(true)
    expect(api.recoverProject).toHaveBeenCalledWith(alpha.id)
    expect(useAppStore.getState().currentSessionId).toBe('alpha-session')
    expect(useAppStore.getState().composerDrafts['alpha-session'].text).toBe('Unsent draft')
    expect(useProjects.getState().projects.filter(item => item.id === alpha.id)).toHaveLength(1)
  })

  it('does not change project or conversation when the recovery picker is cancelled', async () => {
    api.recoverProject.mockResolvedValue({ ok: false, error: 'cancelled' })
    useProjects.setState({ error: 'missing', errorProjectId: alpha.id })
    useAppStore.setState({ currentSessionId: 'alpha-session' })
    expect(await useProjects.getState().recover(alpha.id)).toBe(false)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(alpha.path)
    expect(useAppStore.getState().currentSessionId).toBe('alpha-session')
    expect(useProjects.getState().error).toBeNull()
  })

  it('does not let delayed recovery take over a newer project selection', async () => {
    const pending = deferred<ProjectResult>()
    api.recoverProject.mockImplementation(() => pending.promise)
    const recovering = useProjects.getState().recover(alpha.id)
    useAppStore.getState().setCurrentWorkspace(grant(beta))
    pending.resolve({ ok: true, project: alpha, grant: grant(alpha) })
    expect(await recovering).toBe(true)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(beta.path)
  })

  it('does not adopt a delayed project after a newer null-to-null New Chat intent', async () => {
    const pending = deferred<ProjectResult>()
    api.activateProject.mockImplementation(() => pending.promise)
    useAppStore.setState({ currentSessionId: null })
    const open = useProjects.getState().activate(beta.id)
    useAppStore.getState().setCurrentSessionId(null)
    pending.resolve({ ok: true, project: beta, grant: grant(beta) })
    expect(await open).toBe(true)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(alpha.path)
  })

  it('reuses the caller intent for internal activation, while an explicit same-project pick starts a new intent', async () => {
    const intent = beginNavigationIntent()
    expect(await useProjects.getState().activate(alpha.id, intent)).toBe(true)
    expect(currentNavigationIntent()).toBe(intent)
    expect(await useProjects.getState().activate(alpha.id)).toBe(true)
    expect(currentNavigationIntent()).toBeGreaterThan(intent)
  })

  it('does not let a late default fallback replace a newer history selection', async () => {
    const pending = deferred<ProjectResult>()
    api.activateProject.mockImplementation(() => pending.promise)
    const archive = useProjects.getState().archive(alpha.id)
    await vi.waitFor(() => expect(api.activateProject).toHaveBeenCalledTimes(1))
    useAppStore.getState().setCurrentWorkspace(grant(beta))
    pending.resolve({ ok: true, project: base, grant: grant(base) })
    expect(await archive).toBe(true)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(beta.path)
  })

  it('keeps a newer selection when a slow project creation finishes', async () => {
    const pending = deferred<ProjectResult>()
    api.createProject.mockImplementation(() => pending.promise)
    const create = useProjects.getState().create('Alpha')
    expect(await useProjects.getState().create('Duplicate')).toBe(false)
    useAppStore.getState().setCurrentWorkspace(grant(beta))
    pending.resolve({ ok: true, project: alpha, grant: grant(alpha) })
    expect(await create).toBe(true)
    expect(api.createProject).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(beta.path)
  })

  it('falls back after partial deletion makes the current folder unavailable, retaining the error', async () => {
    rows = rows.map(item => item.id === alpha.id ? { ...item, missing: true } : item)
    api.deleteProject.mockResolvedValue({ ok: false, error: 'partial-failure' })
    expect(await useProjects.getState().remove(alpha.id)).toBe(false)
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(base.path)
    expect(useProjects.getState().projects.find(item => item.id === alpha.id)?.missing).toBe(true)
    expect(useProjects.getState().error).toBe('partial-failure')
  })

  it('removes only the deleted project session projections and preserves other drafts', async () => {
    const sessions: Session[] = [alpha, beta].map(item => ({ id: item.id, cwd: item.path, title: item.name, status: 'idle', createdAt: 1 }))
    useAppStore.setState({ sessions, composerDrafts: { alpha: { text: 'A draft', images: [] }, beta: { text: 'B draft', images: [] } }, messages: { alpha: [], beta: [] }, busy: { alpha: false, beta: false } })
    api.deleteProject.mockResolvedValue({ ok: true, project: alpha })
    rows = rows.filter(item => item.id !== alpha.id)
    expect(await useProjects.getState().remove(alpha.id)).toBe(true)
    expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['beta'])
    expect(useAppStore.getState().composerDrafts).toEqual({ beta: { text: 'B draft', images: [] } })
    expect(Object.keys(useAppStore.getState().messages)).toEqual(['beta'])
    expect(useAppStore.getState().currentWorkspace?.realPath).toBe(base.path)
  })
})
