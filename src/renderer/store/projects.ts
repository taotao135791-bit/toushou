import { create } from 'zustand'
import type { ProjectError, ProjectRecord, ProjectResult, WorkspaceGrant } from '@shared/types'
import { useAppStore } from './index'
import { beginNavigationIntent, isCurrentNavigationIntent } from '../lib/navigationIntent'

interface ProjectsState {
  projects: ProjectRecord[]
  loaded: boolean
  loading: boolean
  pending: string | null
  error: ProjectError | 'load-failed' | null
  refresh: () => Promise<void>
  activate: (id: string, navigationIntent?: number) => Promise<boolean>
  create: (name: string) => Promise<boolean>
  importFolder: () => Promise<boolean>
  archive: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  clearError: () => void
}

/** One controller for both entry points: a mutation cannot be submitted twice. */
export const useProjects = create<ProjectsState>((set, get) => {
  let readEpoch = 0
  const adopt = async (grant: WorkspaceGrant) => {
    const app = useAppStore.getState()
    app.setCurrentWorkspace(grant)
    try { app.setRecentWorkspaces(await window.electronAPI.listRecentWorkspaces()) } catch { /* Project activation remains usable. */ }
  }
  const fallback = async (intent: number) => {
    if (!isCurrentNavigationIntent(intent)) return
    const origin = useAppStore.getState().currentWorkspace?.id
    const session = useAppStore.getState().currentSessionId
    const result = await window.electronAPI.activateProject(get().projects.find(project => project.isDefault)?.id ?? '')
    if (!isCurrentNavigationIntent(intent) || useAppStore.getState().currentWorkspace?.id !== origin || useAppStore.getState().currentSessionId !== session) return
    if (result.ok && result.grant) await adopt(result.grant)
    else useAppStore.getState().setCurrentWorkspace(null)
  }
  const refresh = async () => {
    const epoch = ++readEpoch
    set({ loading: true })
    try {
      const projects = await window.electronAPI.listProjects()
      if (epoch === readEpoch) set({ projects, loaded: true, loading: false, error: get().error === 'load-failed' ? null : get().error })
    } catch {
      if (epoch === readEpoch) set({ loading: false, error: 'load-failed' })
    }
  }
  const run = async (key: string, operation: () => Promise<ProjectResult>, after?: (project: ProjectRecord, intent: number) => Promise<void>, navigationIntent?: number) => {
    if (get().pending) return false
    const intent = navigationIntent ?? beginNavigationIntent()
    if (!isCurrentNavigationIntent(intent)) return false
    set({ pending: key, error: null })
    const origin = useAppStore.getState().currentWorkspace?.id
    const session = useAppStore.getState().currentSessionId
    ++readEpoch
    try {
      const result = await operation()
      if (!result.ok) {
        if (result.error !== 'cancelled') set({ error: result.error })
        if (result.error === 'partial-failure' || result.error === 'path-changed' || result.error === 'missing') {
          await refresh()
          const active = useAppStore.getState().currentWorkspace
          if (active && get().projects.some(project => project.path === active.realPath && project.missing)) await fallback(intent)
        }
        return false
      }
      if (result.grant && isCurrentNavigationIntent(intent) && useAppStore.getState().currentWorkspace?.id === origin && useAppStore.getState().currentSessionId === session) await adopt(result.grant)
      if (after) await after(result.project, intent)
      await refresh()
      return true
    } catch {
      set({ error: 'failed' })
      return false
    } finally {
      set({ pending: null, loading: false })
    }
  }
  return {
    projects: [], loaded: false, loading: false, pending: null, error: null,
    refresh,
    clearError: () => set({ error: null }),
    activate: (id, intent) => run(`activate:${id}`, () => window.electronAPI.activateProject(id), undefined, intent),
    create: name => run('create', () => window.electronAPI.createProject(name)),
    importFolder: () => run('import', () => window.electronAPI.importProject()),
    archive: id => run(`archive:${id}`, () => window.electronAPI.archiveProject(id), async (project, intent) => {
      if (useAppStore.getState().currentWorkspace?.realPath === project.path) await fallback(intent)
    }),
    restore: id => run(`restore:${id}`, () => window.electronAPI.restoreProject(id)),
    remove: id => run(`delete:${id}`, () => window.electronAPI.deleteProject(id), async (project, intent) => {
      const app = useAppStore.getState()
      if (app.currentWorkspace?.realPath === project.path) await fallback(intent)
      // Main has stopped idle runtime sessions and removed their durable files.
      // Forget local projections too, so a deleted project cannot reappear.
      const removed = new Set(useAppStore.getState().sessions.filter(session => session.cwd === project.path).map(session => session.id))
      useAppStore.getState().setSessions(useAppStore.getState().sessions.filter(session => !removed.has(session.id)))
      useAppStore.setState(state => ({
        sessionRecords: state.sessionRecords.filter(record => record.workspaceRealPath !== project.path),
        globalHistory: state.globalHistory.filter(row => row.cwd !== project.path),
        messages: Object.fromEntries(Object.entries(state.messages).filter(([id]) => !removed.has(id))),
        busy: Object.fromEntries(Object.entries(state.busy).filter(([id]) => !removed.has(id))),
        queuedMessages: Object.fromEntries(Object.entries(state.queuedMessages).filter(([id]) => !removed.has(id)))
      }))
      await useAppStore.getState().loadAllHistorySessions()
    })
  }
})
