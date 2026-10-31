import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import BoardsPage from '../BoardsPage'
import type { KanbanBoard } from '@shared/types'
import { buildTikTokDatasetProofs } from '@shared/tiktokDatasetProof'

const saved: KanbanBoard[] = []
const pendingRequests = new Map<string, (value: unknown) => void>()
const scenario: { summary: unknown; datasets: unknown[]; datasetFail: boolean; pending: boolean; todayPending: boolean; lastRequest: string | null; todayRequest: string | null; progress: ((value: { requestId: string; completed: number; total: number; succeeded: number }) => void) | null; cancelled: string[] } = { summary: { ok: false, error: 'no-credentials' }, datasets: [], datasetFail: false, pending: false, todayPending: false, lastRequest: null, todayRequest: null, progress: null, cancelled: [] }
const existing: KanbanBoard = {
  id: 'fixture-existing', name: 'Existing board', createdAt: 1, updatedAt: 1,
  widgets: Array.from({ length: 5 }, (_, index) => ({
    id: `fixture-clock-${index}`, type: 'clock' as const, title: `Clock ${index}`,
    layout: { x: 0, y: index * 6, w: 12, h: 6 }, config: {}
  }))
}
Object.assign(window, {
  electronAPI: {
    listBoards: async () => [existing],
    listBoardDatasets: async () => { if (scenario.datasetFail) throw new Error('synthetic dataset failure'); return scenario.datasets },
    listFbReadingAccounts: async () => [],
    listFbReadings: async () => [],
    googleReportReadingGet: async () => null,
    ttReadingToday: async (input: { requestId?: string }) => { scenario.todayRequest = input.requestId ?? null; if (scenario.todayPending) return new Promise((resolve) => { if (input.requestId) pendingRequests.set(input.requestId, resolve) }); return { ok: false, error: 'no-credentials' } },
    ttReadingSummary: async (input: { requestId?: string }) => { scenario.lastRequest = input.requestId ?? null; if (scenario.pending) return new Promise((resolve) => { if (input.requestId) pendingRequests.set(input.requestId, resolve) }); return scenario.summary },
    onTtReadingProgress: (fn: NonNullable<typeof scenario.progress>) => { scenario.progress = fn; return () => { if (scenario.progress === fn) scenario.progress = null } },
    ttReadingCancel: async (id: string) => { scenario.cancelled.push(id); const resolve = pendingRequests.get(id); if (!resolve) return false; pendingRequests.delete(id); setTimeout(() => resolve({ ok: false, error: 'api', detail: 'reading-cancelled' }), 0); return true },
    fxRatesGet: async () => null,
    getBoardDesign: async () => ({ spec: null }),
    onBoardDesignChanged: () => () => {},
    saveBoard: async (board: KanbanBoard) => { saved.push(board); return { ok: true } }
  },
  boardFixture: { saved, scenario, buildTikTokDatasetProofs }
})
function Fixture() {
  const location = useLocation()
  return <><div id="fixture-route">{location.pathname}</div><BoardsPage /></>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
