import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { Session } from '@shared/types'
import ChatPanel from './ChatPanel'
import { useAppStore } from '../store'

const current: Session = { id: 'current', cwd: '/synthetic/current', title: 'Current conversation', status: 'idle', createdAt: 1 }
const sessions: Session[] = [current, ...Array.from({ length: 200 }, (_, i) => ({ ...current, id: `background-${i}`, title: `Background ${i}` }))]
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
  showError() { useAppStore.getState().setSessionError('current', 'chat.sendFailed') }
}
declare global { interface Window { chatPerfFixture: typeof fixture } }
window.chatPerfFixture = fixture
window.electronAPI = {
  listCommands: async () => [], getModelConfig: async () => ({ defaultThinkingLevel: 'auto' }), listModels: async () => [],
  gitInfo: async () => null, getSessionState: async () => null, getSessionStats: async () => null, setStore: async () => undefined
} as unknown as typeof window.electronAPI
useAppStore.setState({ language: 'en', currentWorkspace: { id: 'grant', realPath: current.cwd, displayPath: current.cwd, source: 'dialog', createdAt: 1 }, currentSessionId: 'current', sessions, sessionRecords: [], messages: {}, busy: {}, sessionErrors: {}, uiRequests: {}, cliAvailable: true })
createRoot(document.getElementById('root')!).render(<MemoryRouter><Profiler id="actual-chat-panel" onRender={(_id, _phase, duration) => { fixture.commits += 1; fixture.renderMs += duration }}><ChatPanel /></Profiler></MemoryRouter>)
