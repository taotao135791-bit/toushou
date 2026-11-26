import './SidebarConversations.fixture'
import { useAppStore } from '../store'
import type { HistorySessionRow } from '@shared/types'

declare global {
  interface Window {
    filingBridge: {
      read: () => Promise<Record<string, string>>
      file: typeof window.electronAPI.fileSidebarConversation
      move: typeof window.electronAPI.moveSidebarConversation
      rows: () => Promise<HistorySessionRow[]>
      seed: (row: HistorySessionRow) => Promise<void>
    }
    filingFixture: { addFresh: () => void; publishDurable: () => Promise<void> }
  }
}
const api = window.electronAPI
const originalGet = api.getStore
api.getStore = ((key: Parameters<typeof originalGet>[0]) => key === 'sidebarSessionProjects' ? window.filingBridge.read() : originalGet(key)) as typeof originalGet
api.fileSidebarConversation = (...args) => window.filingBridge.file(...args)
const phase = new URLSearchParams(location.search).get('phase')
function updateRows(rows: HistorySessionRow[]) {
  const updated = new Set(rows.map(row => row.uuid))
  window.sidebarFixture.rows.splice(0, Infinity, ...window.sidebarFixture.rows.filter(row => !updated.has(row.uuid)), ...rows)
}
const hydrate = window.filingBridge.rows().then(updateRows)
const originalListAll = api.listAllSessionHistory
const originalListScoped = api.listSessionHistory
api.listAllSessionHistory = async () => { await hydrate; return originalListAll() }
api.listSessionHistory = async (...args) => { await hydrate; return originalListScoped(...args) }
api.moveSidebarConversation = async (...args) => {
  const result = await window.filingBridge.move(...args)
  if (result.ok) updateRows([result.row])
  return result
}
const originalResume = api.resumeSession
api.resumeSession = async (...args) => {
  const result = await originalResume(...args)
  return result && { ...result, messages: [{ id: 'original-prompt', role: 'user', content: 'Synthetic original context' }] }
}
const initial = useAppStore.getState().sessions[0]
const uuid = window.sidebarFixture.uuid(59)
const saved = { uuid, cwd: initial.cwd, title: 'Fresh filing test', timestamp: 102 }
window.filingFixture = {
  addFresh() { useAppStore.getState().addSession({ id: 'new-runtime', cwd: initial.cwd, status: 'idle', createdAt: 102, title: saved.title }, false) },
  async publishDurable() {
    await window.filingBridge.seed(saved)
    useAppStore.getState().setSessionFile('new-runtime', `/synthetic/${uuid}.jsonl`, uuid)
  }
}
if (phase !== 'save') {
  useAppStore.setState({ sessions: [], sessionRecords: [], currentSessionId: null })
}
