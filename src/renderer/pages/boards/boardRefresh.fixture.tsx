import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BoardsPage from '../BoardsPage'
import { useAppStore } from '../../store'
import type { BoardDataset, KanbanBoard } from '@shared/types'
import type { AppsFlyerDatasetRefreshRequest } from '@shared/appsflyerDataset'
import { boardReportWindow, boardRefreshPlanKey } from '@shared/boardWindows'
import type { BoardRefreshResult } from '@shared/boardRefresh'
import type { MetaReadingSummary } from '@shared/metaReading'
import { metaReadingDataset } from '@shared/metaReadingDataset'

useAppStore.setState({ language: 'en' })
const board: KanbanBoard = { id: 'board-refresh-fixture', name: 'Refresh fixture', createdAt: 1, updatedAt: 1, masterScope: { range: 'last7', metrics: ['spend'] }, widgets: [
  { id: 'tt-reader', type: 'tt-reading', title: 'TT (Last 30 days)', config: { advertiserIds: '7300000000000000001', range: '7' }, layout: { x: 0, y: 0, w: 6, h: 5 } },
  { id: 'af-counter', type: 'counter', title: 'AF registrations', config: { source: 'dataset', datasetId: 'af-bound', metric: 'Count', op: 'sum' }, layout: { x: 6, y: 0, w: 3, h: 3 } },
  { id: 'fixed-counter', type: 'counter', title: 'Fixed reference', config: { source: 'manual', value: 17 }, layout: { x: 9, y: 0, w: 3, h: 3 } }
] }
const metaBoard: KanbanBoard = { id: 'meta-refresh-fixture', name: 'Meta fixture', createdAt: 1, updatedAt: 1, masterScope: { range: 'last7', metrics: ['spend'] }, widgets: [
  { id: 'meta-reader', type: 'meta-reading', title: 'Meta reading', config: { accountId: '', range: 'last7' }, layout: { x: 0, y: 0, w: 6, h: 5 } },
  { id: 'meta-spend', type: 'counter', title: 'Meta spend', config: { source: 'dataset', datasetId: 'meta-reading:meta-reader', metric: 'spend', op: 'sum' }, layout: { x: 6, y: 0, w: 3, h: 3 } }
] }
const metaListeners = new Set<(status: { connected: boolean }) => void>()
let datasets: BoardDataset[] = [{ id: 'af-bound', name: 'AF-Synthetic', createdAt: 1, columns: [{ name: 'Date', type: 'date' }, { name: 'Count', type: 'number' }], rows: [['2020-01-01', 999]] }, { id: 'af-other', name: 'AF-Other board', createdAt: 1, columns: [{ name: 'Count', type: 'number' }], rows: [[888]] }]
const fixture = { board, meta: { refreshCalls: 0, summaryCalls: 0, accountsCalls: 0, fail: false }, emitMeta: (connected: boolean) => metaListeners.forEach(listener => listener({ connected })), media: [] as Array<{ range: string }>, af: [] as AppsFlyerDatasetRefreshRequest[], pending: false, unbound: false, empty: false, partial: false, resolve: null as null | (() => void) }
Object.assign(window, { boardRefreshFixture: fixture, electronAPI: {
  cleanupOrphanedHtmlBoards: async () => ({ ok: true }), listBoards: async () => [board, metaBoard], listBoardDatasets: async () => structuredClone(datasets),
  listFbReadingAccounts: async () => [], listFbReadings: async () => [], ttReadingAdvertisers: async () => ({ selected: [], granted: [], accounts: [] }),
  getBoardDesign: async () => ({ spec: null }), onBoardDesignChanged: () => () => {}, onTtReadingProgress: () => () => {}, fxRatesGet: async () => null,
  saveBoard: async (next: KanbanBoard) => { Object.assign(next.id === metaBoard.id ? metaBoard : board, structuredClone(next)); return { ok: true } },
  onMetaAdsStatus: (listener: (status: { connected: boolean }) => void) => { metaListeners.add(listener); return () => { metaListeners.delete(listener) } },
  metaAdsReading: async (input: { action: string }) => { if (input.action === 'accounts') { fixture.meta.accountsCalls++; return { ok: true, data: { accounts: [{ id: 'act_123', name: 'Synthetic Meta', currency: 'USD', timezone: 'UTC' }], partial: false } } } fixture.meta.summaryCalls++; return { ok: false, error: 'Unexpected direct summary' } },
  ttReadingSummary: async (input: { range: string }) => { fixture.media.push(input); return { ok: false, error: 'no-credentials' } }, ttReadingCancel: async () => true,
  boardRefresh: async (input: { boardId: string }): Promise<BoardRefreshResult> => {
    if (input.boardId === metaBoard.id) {
      fixture.meta.refreshCalls++
      const captured = structuredClone(metaBoard), window = boardReportWindow(captured), selected = captured.widgets[0].config.accountId
      const status = !selected ? 'unbound' as const : fixture.meta.fail ? 'failed' as const : 'updated' as const
      const summary: MetaReadingSummary = { account: { id: 'act_123', name: 'Synthetic Meta', currency: 'USD', timezone: 'UTC' }, range: 'last7', start: window.start, end: window.end, readAt: Date.now(), rows: [{ date: window.start, spend: 10, impressions: 100, clicks: 5 }, { date: window.end, spend: 20, impressions: 200, clicks: 10 }] }
      return { ok: status === 'updated', boardId: captured.id, runId: `meta-${fixture.meta.refreshCalls}`, planKey: boardRefreshPlanKey(captured), reportWindow: window, generatedAt: Date.now(), status: status === 'updated' ? 'ready' : 'failed', sources: [{ key: 'meta', kind: 'meta', status, window, ...(status === 'updated' ? { dataset: metaReadingDataset('meta-reader', summary) } : { error: status === 'unbound' ? 'source-selection-required' : 'meta-read-failed' }) }], widgets: [{ widgetId: 'meta-reader', window, status, bindings: [], nativeSourceKey: 'meta', ...(status === 'updated' ? { metaSummary: summary } : { metaAccounts: [summary.account] }) }, { widgetId: 'meta-spend', window, status, bindings: [{ datasetId: 'meta-reading:meta-reader', sourceKey: 'meta', window }] }] }
    }
    const captured = structuredClone(board), window = boardReportWindow(captured)
    fixture.media.push({ range: captured.masterScope?.range === 'yesterday' ? 'yd' : captured.masterScope?.range === 'today' ? '1' : captured.masterScope?.range === 'last3' ? '3' : captured.masterScope?.range === 'last30' ? '30' : '7' })
    fixture.af.push({ ...window, datasetIds: ['af-bound'] })
    if (fixture.pending) await new Promise<void>(resolve => { fixture.resolve = resolve })
    const status = fixture.unbound ? 'unbound' as const : fixture.empty ? 'empty' as const : 'updated' as const
    datasets = datasets.map(dataset => dataset.id === 'af-bound' ? { ...dataset, rows: fixture.empty ? [] : [[window.end, fixture.af.length]], appsflyer: { specId: 'query-synthetic', status, window, dataWindow: window, attemptedAt: Date.now() } } : dataset)
    return { ok: false, boardId: captured.id, runId: `synthetic-${fixture.af.length}`, planKey: boardRefreshPlanKey(captured), reportWindow: window, generatedAt: Date.now(), status: 'partial', sources: [{ key: 'tt', kind: 'tiktok', status: 'failed', window, error: 'no-credentials' }, { key: 'af', kind: 'appsflyer', status, window, ...(fixture.partial ? { partial: true } : {}), dataset: structuredClone(datasets[0]) }], widgets: [{ widgetId: 'tt-reader', window, status: 'failed', bindings: [], nativeSourceKey: 'tt' }, { widgetId: 'af-counter', window, status, bindings: [{ datasetId: 'af-bound', sourceKey: 'af' }] }] }
  },
  appsflyerDatasetRefresh: async (input: AppsFlyerDatasetRefreshRequest) => {
    fixture.af.push(input)
    if (fixture.pending) await new Promise<void>(resolve => { fixture.resolve = resolve })
    const window = { start: input.start, end: input.end }
    const status = fixture.unbound ? 'unbound' as const : fixture.empty ? 'empty' as const : 'updated' as const
    datasets = datasets.map(dataset => dataset.id === 'af-bound' ? { ...dataset, rows: fixture.empty ? [] : [[input.end, fixture.af.length]], appsflyer: { specId: 'query-synthetic', status, window, dataWindow: window, attemptedAt: Date.now() } } : dataset)
    return { ok: !fixture.unbound, results: [{ name: 'Synthetic', datasetName: 'AF-Synthetic', datasetId: 'af-bound', ok: !fixture.unbound, status, window, ...(fixture.unbound ? { error: 'missing-query' } : {}) }] }
  }
} })
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/boards']}><BoardsPage /></MemoryRouter>)
