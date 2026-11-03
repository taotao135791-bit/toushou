import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { ProjectRecord, ProjectResult, Session, WorkspaceGrant } from '@shared/types'
import SidebarProjects from './SidebarProjects'
import Composer from './Composer'
import { useProjects } from '../store/projects'
import { useAppStore } from '../store'

const project = (id: string, name: string, path: string, isDefault = false): ProjectRecord => ({ id, name, path, isDefault, archived: false, missing: false, createdAt: 1 })
const fixture = {
  projects: [project('default', 'TouShou workspace', '/synthetic/default', true), project('alpha', 'Alpha', '/synthetic/alpha'), project('long', 'Long path project', '/synthetic/' + Array.from({ length: 60 }, (_, i) => `nested-folder-${i}`).join('/'))],
  nextCreate: 'success' as 'success' | 'failed' | 'cancelled',
  creates: [] as string[],
  imports: 0,
  deleteRequests: 0,
  finishDelete: null as ((confirm: boolean) => void) | null,
  clipboard: '',
  grant(row: ProjectRecord): WorkspaceGrant { return { id: `grant-${row.id}`, realPath: row.path, displayPath: row.path, source: row.isDefault ? 'default' : 'dialog', createdAt: 1 } },
  snapshot() {
    const state = useAppStore.getState()
    return { current: state.currentWorkspace?.realPath, projects: useProjects.getState().projects, pending: useProjects.getState().pending, sessions: state.sessions.map(session => session.id), drafts: Object.keys(state.composerDrafts) }
  },
  seedSession(id: string) {
    const row = fixture.projects.find(item => item.id === id)!
    useAppStore.setState({ sessions: [{ id: 'project-session', cwd: row.path, title: 'Synthetic session', createdAt: 1, status: 'idle' } as Session], composerDrafts: { 'project-session': { text: 'Private synthetic draft', images: [] } } })
  }
}
declare global { interface Window { projectsFixture: typeof fixture } }
window.projectsFixture = fixture
Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { fixture.clipboard = text } })
window.electronAPI = {
  listProjects: async () => structuredClone(fixture.projects),
  listRecentWorkspaces: async () => fixture.projects.filter(row => !row.archived).map(row => ({ id: row.id, displayPath: row.path, lastUsedAt: 1 })),
  activateProject: async (id: string): Promise<ProjectResult> => {
    const row = fixture.projects.find(item => item.id === id)
    return row ? { ok: true, project: structuredClone(row), grant: fixture.grant(row) } : { ok: false, error: 'not-found' }
  },
  createProject: async (name: string): Promise<ProjectResult> => {
    fixture.creates.push(name)
    if (fixture.nextCreate !== 'success') { const error = fixture.nextCreate; fixture.nextCreate = 'success'; return { ok: false, error } }
    const row = project(`created-${fixture.creates.length}`, name, `/synthetic/projects/${name}`)
    fixture.projects.push(row)
    return { ok: true, project: structuredClone(row), grant: fixture.grant(row) }
  },
  importProject: async (): Promise<ProjectResult> => {
    const name = ++fixture.imports === 1 ? 'Sidebar import' : 'Composer import'
    const row = project(`imported-${fixture.imports}`, name, `/synthetic/imports/${name}`)
    fixture.projects.push(row)
    return { ok: true, project: structuredClone(row), grant: fixture.grant(row) }
  },
  archiveProject: async (id: string): Promise<ProjectResult> => { const row = fixture.projects.find(item => item.id === id)!; row.archived = true; return { ok: true, project: structuredClone(row) } },
  restoreProject: async (id: string): Promise<ProjectResult> => { const row = fixture.projects.find(item => item.id === id)!; row.archived = false; return { ok: true, project: structuredClone(row) } },
  deleteProject: (id: string): Promise<ProjectResult> => new Promise(resolve => {
    fixture.deleteRequests += 1
    fixture.finishDelete = confirm => {
      fixture.finishDelete = null
      const row = fixture.projects.find(item => item.id === id)!
      if (!confirm) { resolve({ ok: false, error: 'cancelled' }); return }
      fixture.projects = fixture.projects.filter(item => item.id !== id)
      resolve({ ok: true, project: structuredClone(row) })
    }
  }),
  listAllSessionHistory: async () => [],
  gitInfo: async () => null,
  getModelConfig: async () => ({ defaultThinkingLevel: 'auto' }),
  listModels: async () => [],
  setStore: async () => undefined
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en', currentSessionId: null, currentWorkspace: null, sessions: [] })
createRoot(document.getElementById('root')!).render(<MemoryRouter><div style={{ display: 'flex', height: '100vh' }}><aside id="sidebar-projects" style={{ width: 260, flexShrink: 0 }}><SidebarProjects /></aside><main id="composer-projects" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}><Composer onSend={() => undefined} /></main></div></MemoryRouter>)
