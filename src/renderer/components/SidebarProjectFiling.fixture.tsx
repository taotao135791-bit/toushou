import './SidebarConversations.fixture'
import { useAppStore } from '../store'

declare global {
  interface Window {
    filingBridge: { read: () => Promise<Record<string, string>>; file: typeof window.electronAPI.fileSidebarConversation }
    filingFixture: { addFresh: () => void; publishDurable: () => void }
  }
}
const api = window.electronAPI
const originalGet = api.getStore
api.getStore = ((key: Parameters<typeof originalGet>[0]) => key === 'sidebarSessionProjects' ? window.filingBridge.read() : originalGet(key)) as typeof originalGet
api.fileSidebarConversation = (...args) => window.filingBridge.file(...args)
const originalResume = api.resumeSession
api.resumeSession = async (...args) => {
  const result = await originalResume(...args)
  return result && { ...result, messages: [{ id: 'original-prompt', role: 'user', content: 'Synthetic original context' }] }
}
const initial = useAppStore.getState().sessions[0]
const uuid = window.sidebarFixture.uuid(59)
const saved = { uuid, cwd: initial.cwd, title: 'Fresh filing test', timestamp: 102 }
window.filingFixture = {
  addFresh() { useAppStore.getState().addSession({ id: 'new-runtime', cwd: initial.cwd, status: 'idle', createdAt: 102, title: saved.title }) },
  publishDurable() { useAppStore.getState().setSessionFile('new-runtime', `/synthetic/${uuid}.jsonl`, uuid) }
}
if (new URLSearchParams(location.search).get('phase') !== 'save') {
  window.sidebarFixture.rows.push(saved)
  useAppStore.setState({ sessions: [], sessionRecords: [], currentSessionId: null })
}
