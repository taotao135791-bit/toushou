import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { SessionUiAnswer } from '@shared/types'
import ExtensionUiDialog from './ExtensionUiDialog'
import MessageList from './MessageList'
import { useAppStore, type MessageLike } from '../store'

useAppStore.setState({ language: 'en' })
const fixture = { checks: [] as unknown[], listCalls: 0, state: useAppStore, answers: [] as SessionUiAnswer[] }
const widget = { id: 'native-table', type: 'table', title: 'Daily table', config: { source: 'dataset', datasetId: 'synthetic-data' }, layout: { x: 0, y: 0, w: 12, h: 7 } }
const output = { ok: true, board: { id: 'synthetic-board', name: 'UNTRUSTED TOOL TITLE', updatedAt: 2, widgets: [widget] }, createdWidgetId: widget.id }
const messages: MessageLike[] = [
  { id: 'request', role: 'user', content: 'Build a daily board' },
  { id: 'create', role: 'assistant', content: '', toolCall: { tool: 'toushou_board_create', input: { template: 'blank' }, output } },
  { id: 'add', role: 'assistant', content: '', toolCall: { tool: 'write', input: { path: 'xd://toushou_board_add_widget', content: '{}' }, output } },
  { id: 'done', role: 'assistant', content: 'Saved.' }
]
const committed: MessageLike[] = [...messages,
  { id: 'edit-request', role: 'user', content: 'Update the selected boards.' },
  { id: 'commit', role: 'assistant', content: '', toolCall: { tool: 'toushou_board_build_commit', input: {}, output: {
    ok: true, published: true, draft: false, boards: [output.board, { id: 'cleared-board', updatedAt: 3, widgets: [] }]
  } } },
  { id: 'edit-done', role: 'assistant', content: 'Saved both updates.' }
]
Object.assign(window, { deliveryFixture: fixture, electronAPI: {
  checkpointList: async () => [],
  getChatBoardPreview: async (input: { sessionId: string }) => { fixture.checks.push(input); return { ok: false, error: input.sessionId === 'ready-session' ? 'unsupported' : 'unauthorized' } },
  respondUi: async (_sessionId: string, _id: string, answer: SessionUiAnswer) => { fixture.answers.push(answer); return true },
  listBoards: async () => { fixture.listCalls++; return [
    { id: 'synthetic-board', name: 'Verified business view', widgets: [widget], createdAt: 1, updatedAt: 2 },
    { id: 'cleared-board', name: 'Verified clean workspace', widgets: [], createdAt: 1, updatedAt: 3 }
  ] }
} })
function Fixture() {
  const [ready, setReady] = useState(false)
  const [edited, setEdited] = useState(false)
  const pending = useAppStore(state => state.uiRequests['ready-session']?.[0])
  const location = useLocation()
  return <>
    <div id="route">{location.pathname + location.search}</div>
    <button id="restore" onClick={() => {
      setReady(true)
      useAppStore.setState({ currentSessionId: 'ready-session' })
      useAppStore.getState().setComposerDraft('ready-session', { text: 'Keep this draft', images: [], files: [] })
    }}>Restore session</button>
    <button id="edit" onClick={() => setEdited(true)}>Show confirmed edit</button>
    <button id="choose" onClick={() => useAppStore.getState().applySessionEvent({
      type: 'ui_request', sessionId: 'ready-session', id: `targets-${fixture.answers.length}`, method: 'board_targets', title: '',
      boards: [
        { id: 'daily', name: 'Commerce daily report', suggested: true },
        { id: 'creative', name: 'Commerce creative review', suggested: true },
        { id: 'archived', name: 'Archive', locked: true }
      ]
    })}>Choose targets</button>
    {pending && <ExtensionUiDialog sessionId="ready-session" request={pending} />}
    <MessageList sessionId={ready ? 'ready-session' : 'unavailable-session'} messages={edited ? committed : messages} />
  </>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
