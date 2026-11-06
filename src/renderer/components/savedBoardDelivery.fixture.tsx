import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import MessageList from './MessageList'
import { useAppStore, type MessageLike } from '../store'

useAppStore.setState({ language: 'en' })
const fixture = { checks: [] as unknown[], listCalls: 0 }
const widget = { id: 'native-table', type: 'table', title: 'Daily table', config: { source: 'dataset', datasetId: 'synthetic-data' }, layout: { x: 0, y: 0, w: 12, h: 7 } }
const output = { ok: true, board: { id: 'synthetic-board', name: 'UNTRUSTED TOOL TITLE', updatedAt: 2, widgets: [widget] }, createdWidgetId: widget.id }
const messages: MessageLike[] = [
  { id: 'request', role: 'user', content: 'Build a daily board' },
  { id: 'create', role: 'assistant', content: '', toolCall: { tool: 'toushou_board_create', input: { template: 'blank' }, output } },
  { id: 'add', role: 'assistant', content: '', toolCall: { tool: 'write', input: { path: 'xd://toushou_board_add_widget', content: '{}' }, output } },
  { id: 'done', role: 'assistant', content: 'Saved.' }
]
Object.assign(window, { deliveryFixture: fixture, electronAPI: {
  checkpointList: async () => [],
  getChatBoardPreview: async (input: { sessionId: string }) => { fixture.checks.push(input); return { ok: false, error: input.sessionId === 'ready-session' ? 'unsupported' : 'unauthorized' } },
  listBoards: async () => { fixture.listCalls++; return [{ id: 'synthetic-board', name: 'Verified business view', widgets: [widget], createdAt: 1, updatedAt: 2 }] }
} })
function Fixture() {
  const [ready, setReady] = useState(false)
  const location = useLocation()
  return <><div id="route">{location.pathname + location.search}</div><button id="restore" onClick={() => setReady(true)}>Restore session</button><MessageList sessionId={ready ? 'ready-session' : 'unavailable-session'} messages={messages} /></>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
