import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import BoardsPage from '../BoardsPage'
import Markdown from '../../components/Markdown'
import type { KanbanBoard } from '@shared/types'
import { buildTikTokDatasetProofs } from '@shared/tiktokDatasetProof'
import { useAppStore } from '../../store'
import { createBoard, createWidget } from '@shared/boards'
import { renderReadingSnapshotHtml } from '@shared/readingSnapshotHtml'
import type { SaveReadingSnapshotInput } from '@shared/readingSnapshot'
import { htmlBoardTemplate, renderHtmlBoard, type HtmlBoardDocument } from '@shared/htmlBoard'
import { parseBoardHighlights, type BoardHighlightEvidence } from '@shared/boardHighlights'

const saved: KanbanBoard[] = []
const v2: { document: HtmlBoardDocument | null; exportHtml: string; evidence: BoardHighlightEvidence | null; applied: number; lastValidation: string | null; showProposal?: (raw: string) => void } = { document: null, exportHtml: '', evidence: null, applied: 0, lastValidation: null }
const revision = `sha256:${'a'.repeat(64)}`
const pendingRequests = new Map<string, (value: unknown) => void>()
const scenario: { summary: unknown; datasets: unknown[]; datasetFail: boolean; pending: boolean; todayPending: boolean; singlePending: boolean; denySingleCancel: boolean; lastRequest: string | null; todayRequest: string | null; todayResult: unknown; todayAlternateResult: unknown; customResult: unknown; partialCancelResult: unknown; singleResult: unknown; singleTodayResult: unknown; clipboard: string; todayInputs: Array<{range?: string; advertiserId?: string; requestId?: string; startDate?: string; endDate?: string}>; progress: ((value: { requestId: string; completed: number; total: number; succeeded: number }) => void) | null; cancelled: string[]; snapshotSaveFail: boolean; snapshotInput: SaveReadingSnapshotInput | null; exportInput: {boardId: string; widgetId: string; anonymize?: boolean; language?: 'zh' | 'en'} | null; exportedHtml: string } = { summary: { ok: false, error: 'no-credentials' }, datasets: [], datasetFail: false, pending: false, todayPending: false, singlePending: false, denySingleCancel: false, lastRequest: null, todayRequest: null, todayResult: null, todayAlternateResult: null, customResult: null, partialCancelResult: null, singleResult: null, singleTodayResult: null, clipboard: '', todayInputs: [], progress: null, cancelled: [], snapshotSaveFail: false, snapshotInput: null, exportInput: null, exportedHtml: '' }
const existing: KanbanBoard = {
  id: 'fixture-existing', name: 'Existing board', createdAt: 1, updatedAt: 1,
  widgets: Array.from({ length: 5 }, (_, index) => ({
    id: `fixture-clock-${index}`, type: 'clock' as const, title: `Clock ${index}`,
    layout: { x: 0, y: index * 6, w: 12, h: 6 }, config: {}
  }))
}
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { scenario.clipboard = text } } })
Object.assign(window, {
  electronAPI: {
    cleanupOrphanedHtmlBoards: async () => ({ ok: true, removed: 0 }),
    listBoards: async () => [...new Map([existing, ...saved].map(board => [board.id, board])).values()],
    listBoardDatasets: async () => { if (scenario.datasetFail) throw new Error('synthetic dataset failure'); return scenario.datasets },
    listFbReadingAccounts: async () => [],
    ttReadingAdvertisers: async () => ({ selected: [], granted: ['7300000000000000001', '7300000000000000002'], accounts: [{ advertiserId: '7300000000000000001', name: 'Fixture Shared' }, { advertiserId: '7300000000000000002', name: 'Fixture Shared' }], namesIncomplete: false }),
    listFbReadings: async () => [],
    googleReportReadingGet: async () => null,
    ttReadingToday: async (input: { requestId?: string; range?: string; advertiserId?: string; startDate?: string; endDate?: string }) => { scenario.todayInputs.push(input); scenario.todayRequest = input.requestId ?? null; if (scenario.todayPending || (input.advertiserId && scenario.singlePending)) return new Promise((resolve) => { if (input.requestId) pendingRequests.set(input.requestId, resolve) }); return (input.range === 'custom' ? scenario.customResult : input.advertiserId ? input.range === 'today' && scenario.singleTodayResult ? scenario.singleTodayResult : scenario.singleResult : input.range === 'today' && scenario.todayAlternateResult ? scenario.todayAlternateResult : scenario.todayResult) ?? { ok: false, error: 'no-credentials' } },
    ttReadingSummary: async (input: { requestId?: string }) => { scenario.lastRequest = input.requestId ?? null; if (scenario.pending) return new Promise((resolve) => { if (input.requestId) pendingRequests.set(input.requestId, resolve) }); return scenario.summary },
    onTtReadingProgress: (fn: NonNullable<typeof scenario.progress>) => { scenario.progress = fn; return () => { if (scenario.progress === fn) scenario.progress = null } },
    ttReadingCancel: async (id: string) => { scenario.cancelled.push(id); if (scenario.denySingleCancel && id === scenario.todayRequest) return false; const resolve = pendingRequests.get(id); if (!resolve) return false; pendingRequests.delete(id); const partial = id === scenario.todayRequest ? scenario.partialCancelResult : null; setTimeout(() => resolve(partial ?? { ok: false, error: 'api', detail: 'reading-cancelled' }), 0); return true },
    fxRatesGet: async () => null,
    getBoardDesign: async () => ({ spec: null }),
    onBoardDesignChanged: () => () => {},
    saveBoard: async (board: KanbanBoard) => { saved.push(board); return { ok: true } },
    saveReadingSnapshot: async (input: SaveReadingSnapshotInput) => { scenario.snapshotInput = structuredClone(input); if (scenario.snapshotSaveFail) return { ok: false, error: 'write-failed' }; const board = createBoard(input.name); board.widgets = [createWidget('reading-snapshot', 'Reading snapshot', { x: 0, y: 0 }, { snapshot: structuredClone(input.snapshot), includeChart: input.includeChart })]; saved.push(board); return { ok: true, board } },
    exportReadingSnapshot: async (input: { boardId: string; widgetId: string; anonymize?: boolean; language?: 'zh' | 'en' }) => { scenario.exportInput = input; const board = saved.find(item => item.id === input.boardId); const widget = board?.widgets.find(item => item.id === input.widgetId && item.type === 'reading-snapshot'); if (!widget) return { ok: false, error: 'not-found' }; scenario.exportedHtml = renderReadingSnapshotHtml(widget.config.snapshot, { anonymize: input.anonymize, includeChart: widget.config.includeChart === true, language: input.language, title: board?.name }); return { ok: true } },
    loadOrCreateHtmlBoard: async (input: { boardId: string; widgetId: string; language: 'en' | 'zh' }) => {
      if (!v2.document) {
        const widget = saved.find(board => board.id === input.boardId)?.widgets.find(item => item.id === input.widgetId)
        if (!widget) return { ok: false, error: 'not-found' }
        v2.document = { schemaVersion: 1, id: 'fixture-doc', revision: 1, source: { boardId: input.boardId, widgetId: input.widgetId, snapshotHash: 'a'.repeat(64) }, snapshot: structuredClone(widget.config.snapshot) as HtmlBoardDocument['snapshot'], includeChart: widget.config.includeChart === true, ...htmlBoardTemplate('editorial', input.language), createdAt: 1, updatedAt: 1 }
      }
      return { ok: true, document: structuredClone(v2.document) }
    },
    saveHtmlBoard: async (input: { id: string; expectedRevision: number; html: string; css: string; theme?: HtmlBoardDocument['theme'] }) => {
      if (!v2.document || v2.document.revision !== input.expectedRevision) return { ok: false, error: 'conflict' }
      v2.document = { ...v2.document, html: input.html, css: input.css, theme: input.theme, revision: input.expectedRevision + 1 }
      return { ok: true, document: structuredClone(v2.document) }
    },
    exportHtmlBoard: async (input: { expectedRevision: number; anonymize: boolean; language: 'zh' | 'en' }) => {
      if (!v2.document || v2.document.revision !== input.expectedRevision) return { ok: false, error: 'conflict' }
      v2.exportHtml = renderHtmlBoard(v2.document, { anonymize: input.anonymize, language: input.language })
      return { ok: true }
    },
    getBoardHighlightEvidence: async (input: { boardId: string; widgetId: string }) => {
      const widget = saved.find(board => board.id === input.boardId)?.widgets.find(item => item.id === input.widgetId)
      const snapshot = widget?.config.snapshot as HtmlBoardDocument['snapshot'] | undefined
      if (!snapshot) return { ok: false, error: 'not-found' }
      v2.evidence = { boardId: input.boardId, widgetId: input.widgetId, revision, capturedAt: snapshot.capturedAt, omittedCount: 0, accounts: snapshot.accounts.map((account, index) => ({ index: index + 1, platform: account.platform, status: account.status, window: account.window, previousWindow: account.previousWindow, sourceAt: account.sourceAt, currency: account.currency, metrics: { spend: account.spend, previousSpend: account.previousSpend, impressions: account.impressions, clicks: account.clicks, conversions: account.conversions } })) }
      return { ok: true, evidence: v2.evidence }
    },
    validateBoardHighlights: async (input: { raw: string }) => {
      const proposal = parseBoardHighlights(input.raw)
      if (!proposal || !v2.evidence) { v2.lastValidation = 'invalid-input'; return { ok: false, error: 'invalid-input' } }
      if (proposal.revision !== v2.evidence.revision) { v2.lastValidation = 'stale-evidence'; return { ok: false, error: 'stale-evidence' } }
      for (const highlight of proposal.highlights) for (const ref of highlight.evidence) {
        const account = v2.evidence.accounts[ref.accountIndex - 1]
        if (!account || account.status !== 'ok' || account.metrics[ref.metric] !== ref.value) { v2.lastValidation = 'invalid-evidence'; return { ok: false, error: 'invalid-evidence' } }
      }
      v2.lastValidation = 'ok'
      return { ok: true, proposal, evidence: v2.evidence }
    },
    applyBoardHighlights: async () => { v2.applied++; return { ok: true } }
  },
  boardFixture: { saved, scenario, v2, buildTikTokDatasetProofs, store: useAppStore, resolvePending: (id: string, value: unknown) => { const resolve = pendingRequests.get(id); pendingRequests.delete(id); resolve?.(value) } }
})
function Fixture() {
  const location = useLocation()
  const [proposal, setProposal] = useState('')
  v2.showProposal = setProposal
  return <><div id="fixture-route">{location.pathname}</div><div id="fixture-chat"><Markdown content={proposal} /></div><BoardsPage /></>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
