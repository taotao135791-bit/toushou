import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { HistorySessionDescriptor, HistorySessionRow, ProjectRecord, Session, WorkspaceGrant } from '@shared/types'
import Sidebar from './Sidebar'
import ChatPanel from './ChatPanel'
import { useAppStore } from '../store'
import { useProjects } from '../store/projects'
import { upsertLiveSessionRecord } from '../lib/sessionRegistry'

const pathA = '/synthetic/client-a/project', pathB = '/synthetic/client-b/project', defaultPath = '/synthetic/TouShou workspace'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const projects: ProjectRecord[] = [{ id: 'default', name: 'TouShou workspace', path: defaultPath, isDefault: true }, { id: 'alpha', name: 'Alpha', path: pathA, isDefault: false }, { id: 'beta', name: 'Beta', path: pathB, isDefault: false }].map(row => ({ ...row, archived: false, missing: false, createdAt: 1 }))
const grant = (id: string): WorkspaceGrant => { const row = projects.find(project => project.id === id)!; return { id: `grant-${id}`, realPath: row.path, displayPath: row.path, source: row.isDefault ? 'default' : 'dialog', createdAt: 1 } }
const live: Session[] = [{ id: 'live-a', cwd: pathA, title: 'Duplicate topic', sessionFile: `/synthetic/${uuid(1)}.jsonl`, createdAt: 100, status: 'idle' }, { id: 'live-b', cwd: pathB, title: 'Beta live conversation', sessionFile: `/synthetic/${uuid(2)}.jsonl`, createdAt: 200, status: 'idle' }]
const rows: HistorySessionRow[] = [
  { uuid: uuid(1), cwd: pathA, title: 'Duplicate topic', timestamp: 100 },
  { uuid: uuid(2), cwd: pathB, title: 'Beta live conversation', timestamp: 200 },
  { uuid: uuid(3), cwd: pathA, title: 'Duplicate topic', timestamp: 110 },
  { uuid: uuid(4), cwd: pathB, title: 'Beta past conversation', timestamp: 210 },
  { uuid: uuid(5), cwd: defaultPath, title: 'No project conversation', timestamp: 300 },
  ...Array.from({ length: 15 }, (_, i) => ({ uuid: uuid(i + 10), cwd: pathA, title: `Alpha prior conversation ${i}`, timestamp: 400 + i }))
]
const fixture = {
  rows, activateCalls: [] as string[], historyCalls: [] as string[], resumeCalls: [] as Array<{ grantId: string; historyId: string; cwd: string }>,
  deleteCalls: 0,
  killed: [] as string[],
  markRunning(id: string) { useAppStore.getState().setBusy(id, true) },
  slowActivation: false, finishActivation: null as (() => void) | null,
  slowCreate: false, finishCreate: null as (() => void) | null,
  creates: [] as string[], sent: [] as Array<{ id: string; text: string }>,
  globalNewChat() { useAppStore.getState().setCurrentSessionId(null) },
  async addBetaHistory() { fixture.rows.push({ uuid: uuid(30), cwd: pathB, title: 'Fresh Beta history', timestamp: 900 }); await useAppStore.getState().loadAllHistorySessions() },
  slowResume: false, finishResume: null as (() => void) | null,
  slowHistory: new Set<string>(),
  pendingHistory: new Map<string, () => void>(),
  beginDefaultScan() {
    fixture.slowHistory.add('grant-default')
    fixture.slowHistory.add('grant-beta')
    useAppStore.getState().setCurrentWorkspace(grant('default'))
  },
  releaseHistory(id: string) {
    fixture.slowHistory.delete(id)
    const finish = fixture.pendingHistory.get(id)
    fixture.pendingHistory.delete(id)
    finish?.()
  },
  archivePastConversation() { useAppStore.getState().setSessionArchived(uuid(10), true) },
  caps: new Map<string, { row: HistorySessionRow; grantId: string }>(),
  snapshot: () => ({ current: useAppStore.getState().currentSessionId, workspace: useAppStore.getState().currentWorkspace?.realPath }),
  pinned: () => useAppStore.getState().pinnedSessionIds,
  uuid
}
declare global { interface Window { sidebarFixture: typeof fixture; keptConversationNode?: Element | null } }
window.sidebarFixture = fixture
window.electronAPI = {
  getStore: async (key: string) => key === 'sidebarWidth' ? 260 : key === 'sessionSort' ? 'recent' : undefined,
  setStore: async () => undefined,
  onTasksStateChanged: () => () => undefined,
  listProjects: async () => structuredClone(projects),
  listRecentWorkspaces: async () => projects.map(row => ({ id: row.id, displayPath: row.path })),
  listAllSessionHistory: async () => structuredClone(fixture.rows),
  listSessionHistory: async (grantId: string): Promise<HistorySessionDescriptor[]> => {
    fixture.historyCalls.push(grantId)
    const generation = fixture.historyCalls.length
    const path = grant(grantId.replace('grant-', '')).realPath
    const read = () => fixture.rows.filter(row => row.cwd === path).map(row => {
      const id = `cap-${generation}-${row.uuid}`
      fixture.caps.set(id, { row, grantId })
      return { id, uuid: row.uuid, title: row.title, timestamp: row.timestamp }
    })
    if (fixture.slowHistory.has(grantId)) return new Promise(resolve => { fixture.pendingHistory.set(grantId, () => resolve(read())) })
    return read()
  },
  activateProject: async (id: string) => {
    fixture.activateCalls.push(id)
    const result = { ok: true, project: projects.find(row => row.id === id), grant: grant(id) }
    if (fixture.slowActivation) return new Promise(resolve => { fixture.finishActivation = () => { fixture.finishActivation = null; resolve(result) } })
    return result
  },
  activateRecentWorkspace: async (id: string) => grant(id),
  resumeSession: (grantId: string, historyId: string) => new Promise(resolve => {
    const cap = fixture.caps.get(historyId)!
    fixture.resumeCalls.push({ grantId, historyId, cwd: cap.row.cwd })
    const finish = () => { fixture.finishResume = null; resolve({ session: { id: `resumed-${cap.row.uuid}`, cwd: cap.row.cwd, title: cap.row.title, createdAt: cap.row.timestamp, status: 'idle', sessionFile: `/synthetic/${cap.row.uuid}.jsonl`, resumedHistoryId: historyId }, messages: [], historicalAgents: [] }) }
    if (fixture.slowResume) fixture.finishResume = finish
    else finish()
  }),
  getSubagents: async () => [],
  getSessionState: async () => null,
  gitInfo: async () => null,
  getModelConfig: async () => ({ defaultThinkingLevel: 'auto' }), listModels: async () => [],
  listCommands: async () => [], getSessionStats: async () => null, checkpointCreate: async () => null,
  createSession: async (grantId: string) => {
    fixture.creates.push(grantId)
    const session: Session = { id: `created-${fixture.creates.length}`, cwd: grant(grantId.replace('grant-', '')).realPath, title: 'project', createdAt: 1000, status: 'idle', sessionFile: `/synthetic/${uuid(50 + fixture.creates.length)}.jsonl` }
    if (fixture.slowCreate) return new Promise(resolve => { fixture.finishCreate = () => { fixture.finishCreate = null; resolve(session) } })
    return session
  },
  sendMessage: async (id: string, text: string) => { fixture.sent.push({ id, text }); return true },
  deleteSessionFile: async () => { fixture.deleteCalls += 1; return false },
  deleteSessionByUuid: async () => { fixture.deleteCalls += 1; return false },
  killSession: async (id: string) => { fixture.killed.push(id) }
} as unknown as typeof window.electronAPI
useProjects.setState({ projects, loaded: true, loading: false, pending: null, error: null })
useAppStore.setState({ language: 'en', currentWorkspace: grant('alpha'), currentSessionId: 'live-a', sessions: live, sessionRecords: live.reduce((records, session) => upsertLiveSessionRecord(records, session, 1), [] as ReturnType<typeof upsertLiveSessionRecord>), globalHistory: [], recentWorkspaces: projects.map(row => ({ id: row.id, displayPath: row.path })), cliAvailable: true, scheduledTasks: [], messages: {}, pinnedSessionIds: [], archivedSessionIds: [], unreadSessionIds: {} })
createRoot(document.getElementById('root')!).render(<MemoryRouter><div style={{ display: 'flex', height: '100vh' }}><Sidebar /><main style={{ flex: 1, minWidth: 0 }}><ChatPanel /></main></div></MemoryRouter>)
