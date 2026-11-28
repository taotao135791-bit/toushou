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
    filingFixture: {
      addFresh: () => void
      publishDurable: () => Promise<void>
      openDefaultLive: () => Promise<void>
      openDefaultPreviewWithoutHistoryRow: () => Promise<void>
      pauseNextMove: () => void
      waitingForMove: () => boolean
      releaseMove: () => void
    }
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
const previewUuid = window.sidebarFixture.uuid(60)
let projectPreviewAsGlobal = false
let pauseMove = false
let resumeMove: (() => void) | undefined
api.listAllSessionHistory = async () => { await hydrate; return originalListAll() }
api.listSessionHistory = async (...args) => {
  await hydrate
  const rows = await originalListScoped(...args)
  return projectPreviewAsGlobal && args[0] === 'grant-default' ? rows.filter(row => row.uuid !== previewUuid) : rows
}
api.moveSidebarConversation = async (...args) => {
  if (pauseMove) {
    pauseMove = false
    await new Promise<void>(resolve => { resumeMove = resolve })
  }
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
async function activateDefault() {
  const result = await api.activateProject('default')
  if (!result?.ok || !result.grant) throw new Error('Fixture could not activate default workspace')
  useAppStore.getState().setCurrentWorkspace(result.grant)
  return result.grant.realPath
}

window.filingFixture = {
  addFresh() { useAppStore.getState().addSession({ id: 'new-runtime', cwd: initial.cwd, status: 'idle', createdAt: 102, title: saved.title }, false) },
  async publishDurable() {
    await window.filingBridge.seed(saved)
    useAppStore.getState().setSessionFile('new-runtime', `/synthetic/${uuid}.jsonl`, uuid)
  },
  async openDefaultLive() {
    const cwd = await activateDefault()
    useAppStore.getState().addSession({ id: 'live-default', cwd, title: 'Default workspace journal', status: 'idle',
      createdAt: 300, sessionFile: `/synthetic/${window.sidebarFixture.uuid(5)}.jsonl` })
  },
  async openDefaultPreviewWithoutHistoryRow() {
    // During a rescan the global row can outlive the scoped history capability.
    projectPreviewAsGlobal = true
    const cwd = await activateDefault()
    const state = useAppStore.getState()
    const id = 'preview:detached-history-fixture'
    const preview = { title: 'Default workspace history preview', failed: false, uuid: previewUuid, cwd }
    state.setSessionPreview(id, preview)
    state.setMessages(id, [{ id: 'default-preview', role: 'user', content: 'Synthetic original context' }])
    state.setCurrentSessionId(id)
  },
  pauseNextMove() { pauseMove = true },
  waitingForMove() { return Boolean(resumeMove) },
  releaseMove() {
    const release = resumeMove
    resumeMove = undefined
    release?.()
  }
}
if (phase !== 'save') {
  useAppStore.setState({ sessions: [], sessionRecords: [], currentSessionId: null })
}
