import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRecord, WorkspaceGrant } from '@shared/types'
import { useAppStore } from '../store'
import { useProjects } from '../store/projects'
import { beginNavigationIntent } from '../lib/navigationIntent'
import { activateSidebarProject } from './Sidebar'

const project: ProjectRecord = { id: 'alpha', name: 'Alpha', path: '/synthetic/alpha', missing: false, archived: false, isDefault: false, createdAt: 1 }
const grant: WorkspaceGrant = { id: 'grant-alpha', realPath: project.path, displayPath: project.path, source: 'dialog', createdAt: 1 }
let activate: ReturnType<typeof vi.fn>

beforeEach(() => {
  activate = vi.fn(async () => true)
  useProjects.setState({ projects: [{ ...project }], loaded: true, loading: false, pending: null, error: null, activate })
  useAppStore.setState({ currentWorkspace: null, currentSessionId: null })
})
afterEach(() => { vi.restoreAllMocks() })

describe('Sidebar project entry validation', () => {
  it.each(['missing', 'archived'] as const)('sends a registered %s project through project activation instead of the legacy recent path', async status => {
    useProjects.setState({ projects: [{ ...project, [status]: true }] })
    activate.mockResolvedValue(false)
    const intent = beginNavigationIntent()
    expect(await activateSidebarProject(project.path, intent)).toBe('unavailable')
    expect(activate).toHaveBeenCalledWith(project.id, intent)
  })

  it.each(['missing', 'archived'] as const)('revalidates a registered %s project even when its old workspace grant is current', async status => {
    useAppStore.setState({ currentWorkspace: grant, currentSessionId: 'old-session' })
    useProjects.setState({ projects: [{ ...project, [status]: true }] })
    activate.mockResolvedValue(false)
    const intent = beginNavigationIntent()
    expect(await activateSidebarProject(project.path, intent)).toBe('unavailable')
    expect(activate).toHaveBeenCalledWith(project.id, intent)
  })

  it('keeps current available projects without creating an extra activation', async () => {
    useAppStore.setState({ currentWorkspace: grant })
    expect(await activateSidebarProject(project.path, beginNavigationIntent())).toBe('registered')
    expect(activate).not.toHaveBeenCalled()
  })

  it('preserves the legacy path for history folders that were never registered', async () => {
    expect(await activateSidebarProject('/synthetic/legacy', beginNavigationIntent())).toBe('legacy')
    expect(activate).not.toHaveBeenCalled()
  })

  it('does not mistake an unloaded or failed project list for an unregistered legacy folder', async () => {
    const refresh = vi.fn(async () => {})
    useProjects.setState({ projects: [], loaded: false, refresh })
    expect(await activateSidebarProject(project.path, beginNavigationIntent())).toBe('unavailable')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not continue after a late activation was superseded by another navigation', async () => {
    let finish!: (value: boolean) => void
    activate.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    const pending = activateSidebarProject(project.path, beginNavigationIntent())
    beginNavigationIntent()
    useAppStore.setState({ currentWorkspace: grant })
    finish(true)
    expect(await pending).toBe('unavailable')
  })
})
