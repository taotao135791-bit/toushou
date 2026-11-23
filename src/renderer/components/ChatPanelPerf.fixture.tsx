import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { ProjectRecord, Session, WorkspaceGrant } from '@shared/types'
import ChatPanel from './ChatPanel'
import { useAppStore } from '../store'
import { useProjects } from '../store/projects'

const current: Session = { id: 'current', cwd: '/synthetic/current', title: 'Current conversation', status: 'idle', createdAt: 1 }
const sessions: Session[] = [current, ...Array.from({ length: 200 }, (_, i) => ({ ...current, id: `background-${i}`, title: `Background ${i}` }))]
const defaultProject: ProjectRecord = { id: 'default', name: 'TouShou workspace', path: '/synthetic/default-save-folder', isDefault: true, archived: false, missing: true, unavailableReason: 'identity-changed', createdAt: 1 }
const defaultGrant: WorkspaceGrant = { id: 'grant-default', realPath: defaultProject.path, displayPath: defaultProject.path, source: 'default', createdAt: 1 }
const thinkingTimers = new Set<number>()
const browserWindow: Window = window
const setInterval = browserWindow.setInterval.bind(browserWindow)
const clearInterval = browserWindow.clearInterval.bind(browserWindow)
browserWindow.setInterval = (handler, timeout, ...args) => {
  const timer = setInterval(handler, timeout, ...args)
  if (timeout === 1000) thinkingTimers.add(timer)
  return timer
}
browserWindow.clearInterval = (timer) => {
  if (timer !== undefined) thinkingTimers.delete(timer)
  clearInterval(timer)
}

const fixture = {
  commits: 0, renderMs: 0, backgroundUpdates: 0,
  reset() { fixture.commits = 0; fixture.renderMs = 0; fixture.backgroundUpdates = 0 },
  async updateBackground() {
    for (let i = 0; i < 200; i++) {
      const id = `background-${i}`
      useAppStore.getState().setSessionTitle(id, `Background changed ${i}`)
      useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === id ? { ...session, status: 'error' } : session))
      await new Promise(requestAnimationFrame)
      fixture.backgroundUpdates += 1
    }
  },
  renameCurrent() { useAppStore.getState().setSessionTitle('current', 'Renamed current conversation') },
  updateCurrentStatus() { useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === 'current' ? { ...session, status: 'error' } : session)) },
  updatePermission() { useAppStore.getState().setSessions(useAppStore.getState().sessions.map(session => session.id === 'current' ? { ...session, readonly: true } : session)) },
  addMessage() { useAppStore.getState().addMessage('current', { id: 'synthetic-message', role: 'user', content: 'Synthetic current message' }) },
  showError() { useAppStore.getState().setSessionError('current', 'chat.sendFailed') },
  showStopError() {
    useAppStore.getState().setBusy('current', true)
    useAppStore.getState().setSessionError('current', 'chat.stopFailed')
  },
  thinkingTimerCount: () => thinkingTimers.size,
  showRestoredThinking() {
    const state = useAppStore.getState()
    state.setBusy('current', false)
    state.setMessages('current', Array.from({ length: 40 }, (_, index) => [
      { id: `history-user-${index}`, role: 'user' as const, content: `Restored prompt ${index}` },
      { id: `history-assistant-${index}`, role: 'assistant' as const, content: `Restored response ${index}`, thinking: 'Restored reasoning' }
    ]).flat())
  },
  streamThinking() {
    const state = useAppStore.getState()
    state.addMessage('current', { id: 'live-question', role: 'user', content: 'Live prompt' })
    state.setBusy('current', true)
    state.appendThinking('current', 'Live reasoning')
  },
  interruptThinking() { useAppStore.getState().applySessionEvent({ type: 'closed', sessionId: 'current' }) },
  recoveryCalls: [] as string[],
  showUnavailableDefault() {
    useProjects.setState({ projects: [{ ...defaultProject }], loaded: true, loading: false, pending: null, error: null, errorProjectId: null })
    useAppStore.getState().setCurrentWorkspace(null)
  },
  recoverySnapshot() { return { calls: fixture.recoveryCalls, workspace: useAppStore.getState().currentWorkspace?.realPath, source: useAppStore.getState().currentWorkspace?.source, missing: useProjects.getState().projects.find(project => project.id === defaultProject.id)?.missing } }
}
declare global { interface Window { chatPerfFixture: typeof fixture } }
window.chatPerfFixture = fixture
window.electronAPI = {
  listCommands: async () => [], getModelConfig: async () => ({ defaultThinkingLevel: 'auto' }), listModels: async () => [],
  gitInfo: async () => null, getSessionState: async () => null, getSessionStats: async () => null, setStore: async () => undefined,
  checkpointList: async () => [],
  listProjects: async () => [{ ...defaultProject }], listRecentWorkspaces: async () => [],
  recoverProject: async (id: string) => { fixture.recoveryCalls.push(id); defaultProject.missing = false; delete defaultProject.unavailableReason; return { ok: true, project: { ...defaultProject }, grant: defaultGrant } }
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en', currentWorkspace: { id: 'grant', realPath: current.cwd, displayPath: current.cwd, source: 'dialog', createdAt: 1 }, currentSessionId: 'current', sessions, sessionRecords: [], messages: {}, busy: {}, sessionErrors: {}, uiRequests: {}, cliAvailable: true })
createRoot(document.getElementById('root')!).render(<MemoryRouter><Profiler id="actual-chat-panel" onRender={(_id, _phase, duration) => { fixture.commits += 1; fixture.renderMs += duration }}><ChatPanel /></Profiler></MemoryRouter>)
