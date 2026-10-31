import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import BoardsPage from '../BoardsPage'
import type { KanbanBoard } from '@shared/types'

const saved: KanbanBoard[] = []
const existing: KanbanBoard = { id: 'fixture-existing', name: 'Existing board', createdAt: 1, updatedAt: 1, widgets: [] }
Object.assign(window, {
  electronAPI: {
    listBoards: async () => [existing],
    listBoardDatasets: async () => [],
    listFbReadingAccounts: async () => [],
    listFbReadings: async () => [],
    ttReadingToday: async () => ({ ok: false, error: 'no-credentials' }),
    ttReadingSummary: async () => ({ ok: false, error: 'no-credentials' }),
    fxRatesGet: async () => null,
    getBoardDesign: async () => ({ spec: null }),
    onBoardDesignChanged: () => () => {},
    saveBoard: async (board: KanbanBoard) => { saved.push(board); return { ok: true } }
  },
  boardFixture: { saved }
})
function Fixture() {
  const location = useLocation()
  return <><div id="fixture-route">{location.pathname}</div><BoardsPage /></>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
