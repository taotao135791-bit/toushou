import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import BoardsPage from '../BoardsPage'
import Markdown from '../../components/Markdown'
import MessageList from '../../components/MessageList'
import type { KanbanBoard } from '@shared/types'
import { buildTikTokDatasetProofs } from '@shared/tiktokDatasetProof'
import { useAppStore } from '../../store'
import { createBoard, createWidget, findFreeSlot, WIDGET_DEFAULT_SIZES } from '@shared/boards'
import { renderReadingSnapshotHtml } from '@shared/readingSnapshotHtml'
import type { SaveReadingSnapshotInput } from '@shared/readingSnapshot'
import { htmlBoardTemplate, renderHtmlBoard, type HtmlBoardDocument } from '@shared/htmlBoard'
import { parseBoardHighlights, type BoardHighlightEvidence } from '@shared/boardHighlights'
import { createReadingModuleWidgets, readingModuleTemplate, type ReadingModuleSpec } from '@shared/readingModules'

const saved: KanbanBoard[] = []
const v2: { document: HtmlBoardDocument | null; exportHtml: string; evidence: BoardHighlightEvidence | null; applied: number; lastValidation: string | null; aiMode: 'fail' | 'pending' | 'success'; aiCalls: number; aiCancels: number; aiInput: unknown; htmlSaveFail: boolean; chatPrompts: string[]; sessionModes: unknown[]; findDelayed?: boolean; findResolve?: () => void; aiResolve?: (result: { ok: false; error: string }) => void; showProposal?: (raw: string) => void } = { document: null, exportHtml: '', evidence: null, applied: 0, lastValidation: null, aiMode: 'fail', aiCalls: 0, aiCancels: 0, aiInput: null, htmlSaveFail: false, chatPrompts: [], sessionModes: [] }
const revision = `sha256:${'a'.repeat(64)}`
const pendingRequests = new Map<string, (value: unknown) => void>()
const scenario: { summary: unknown; datasets: unknown[]; datasetFail: boolean; pending: boolean; todayPending: boolean; singlePending: boolean; denySingleCancel: boolean; lastRequest: string | null; todayRequest: string | null; todayResult: unknown; todayAlternateResult: unknown; customResult: unknown; partialCancelResult: unknown; singleResult: unknown; singleTodayResult: unknown; clipboard: string; todayInputs: Array<{range?: string; advertiserId?: string; requestId?: string; startDate?: string; endDate?: string}>; progress: ((value: { requestId: string; completed: number; total: number; succeeded: number }) => void) | null; cancelled: string[]; snapshotSaveFail: boolean; appendConflict: boolean; snapshotInput: SaveReadingSnapshotInput | null; exportInput: {boardId: string; widgetId: string; anonymize?: boolean; language?: 'zh' | 'en'} | null; exportedHtml: string } = { summary: { ok: false, error: 'no-credentials' }, datasets: [], datasetFail: false, pending: false, todayPending: false, singlePending: false, denySingleCancel: false, lastRequest: null, todayRequest: null, todayResult: null, todayAlternateResult: null, customResult: null, partialCancelResult: null, singleResult: null, singleTodayResult: null, clipboard: '', todayInputs: [], progress: null, cancelled: [], snapshotSaveFail: false, appendConflict: false, snapshotInput: null, exportInput: null, exportedHtml: '' }
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
    createSession: async (_workspaceId: string, options: unknown) => { v2.sessionModes.push(options); return { id: `synthetic-chat-${v2.sessionModes.length}` } },
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
    saveReadingSnapshot: async (input: SaveReadingSnapshotInput) => {
      scenario.snapshotInput = structuredClone(input)
      if (scenario.snapshotSaveFail) return { ok: false, error: 'write-failed' }
      const prior = input.target ? [...saved].reverse().find(board => board.id === input.target!.boardId) : undefined
      if (input.target && !prior) return { ok: false, error: 'not-found' }
      if (input.target && (scenario.appendConflict || prior!.updatedAt !== input.target.expectedUpdatedAt)) return { ok: false, error: 'conflict' }
      const board = prior ? structuredClone(prior) : createBoard(input.name)
      const modules = input.presentation === 'report' ? [] : createReadingModuleWidgets(input.snapshot, input.includeChart, input.language)
      const offset = board.widgets.reduce((end, item) => Math.max(end, item.layout.y + item.layout.h), 0)
      for (const module of modules) module.layout.y += offset
      board.widgets.push(...modules)
      const size = WIDGET_DEFAULT_SIZES['reading-snapshot']
      const widget = createWidget('reading-snapshot', 'Full source snapshot', board.widgets.length ? findFreeSlot(board.widgets, size.w, size.h) : { x: 0, y: 0 }, { snapshot: structuredClone(input.snapshot), includeChart: input.includeChart })
      board.widgets.push(widget)
      if (prior) { board.updatedAt = Math.max(Date.now(), prior.updatedAt + 1); const index = saved.lastIndexOf(prior); saved[index] = board }
      else saved.push(board)
      return { ok: true, board, widgetId: widget.id, focusWidgetId: modules[0]?.id ?? widget.id }
    },
    exportReadingSnapshot: async (input: { boardId: string; widgetId: string; anonymize?: boolean; language?: 'zh' | 'en' }) => { scenario.exportInput = input; const board = saved.find(item => item.id === input.boardId); const widget = board?.widgets.find(item => item.id === input.widgetId && item.type === 'reading-snapshot'); if (!widget) return { ok: false, error: 'not-found' }; scenario.exportedHtml = renderReadingSnapshotHtml(widget.config.snapshot, { anonymize: input.anonymize, includeChart: widget.config.includeChart === true, language: input.language, title: board?.name }); return { ok: true } },
    findHtmlBoardForReading: async (input: { boardId: string; widgetId: string }) => {
      const widget = saved.find(board => board.id === input.boardId)?.widgets.find(item => item.id === input.widgetId)
      const existing = v2.document && v2.document.source.boardId === input.boardId && v2.document.source.widgetId === input.widgetId ? structuredClone(v2.document) : null
      if (v2.findDelayed && widget) {
        const old = existing ?? { schemaVersion: 1 as const, id: 'fixture-doc', revision: 1, source: { boardId: input.boardId, widgetId: input.widgetId, snapshotHash: 'a'.repeat(64) }, snapshot: structuredClone(widget.config.snapshot) as HtmlBoardDocument['snapshot'], includeChart: widget.config.includeChart === true, ...htmlBoardTemplate('editorial', 'en'), createdAt: 1, updatedAt: 1 }
        return await new Promise(resolve => { v2.findResolve = () => resolve({ ok: true, document: old }) })
      }
      if (existing) return { ok: true, document: existing }
      if (widget?.type === 'reading-module') return { ok: true, document: { schemaVersion: 1, id: `fixture-${widget.id}`, revision: 1, source: { boardId: input.boardId, widgetId: input.widgetId, snapshotHash: 'a'.repeat(64) }, snapshot: structuredClone(widget.config.snapshot), includeChart: false, mode: 'module', ...readingModuleTemplate(widget.config.module as ReadingModuleSpec, widget.config.snapshot as HtmlBoardDocument['snapshot'], 'en'), theme: 'minimal', createdAt: 1, updatedAt: 1 } }
      return { ok: false, error: 'not-found' }
    },
    loadOrCreateHtmlBoard: async (input: { boardId: string; widgetId: string; language: 'en' | 'zh' }) => {
      if (!v2.document || v2.document.source.boardId !== input.boardId || v2.document.source.widgetId !== input.widgetId) {
        const widget = saved.find(board => board.id === input.boardId)?.widgets.find(item => item.id === input.widgetId)
        if (!widget) return { ok: false, error: 'not-found' }
        const template = widget.type === 'reading-module' ? { ...readingModuleTemplate(widget.config.module as ReadingModuleSpec, widget.config.snapshot as HtmlBoardDocument['snapshot'], input.language), mode: 'module' as const, theme: 'minimal' as const } : htmlBoardTemplate('editorial', input.language)
        v2.document = { schemaVersion: 1, id: 'fixture-doc', revision: 1, source: { boardId: input.boardId, widgetId: input.widgetId, snapshotHash: 'a'.repeat(64) }, snapshot: structuredClone(widget.config.snapshot) as HtmlBoardDocument['snapshot'], includeChart: widget.config.includeChart === true, ...template, createdAt: 1, updatedAt: 1 }
      }
      return { ok: true, document: structuredClone(v2.document) }
    },
    saveHtmlBoard: async (input: { id: string; expectedRevision: number; html: string; css: string; theme?: HtmlBoardDocument['theme'] }) => {
      if (v2.htmlSaveFail) return { ok: false, error: 'write-failed' }
      if (!v2.document || v2.document.revision !== input.expectedRevision) return { ok: false, error: 'conflict' }
      v2.document = { ...v2.document, html: input.html, css: input.css, theme: input.theme, revision: input.expectedRevision + 1 }
      return { ok: true, document: structuredClone(v2.document) }
    },
    exportHtmlBoard: async (input: { expectedRevision: number; anonymize: boolean; language: 'zh' | 'en' }) => {
      if (!v2.document || v2.document.revision !== input.expectedRevision) return { ok: false, error: 'conflict' }
      v2.exportHtml = renderHtmlBoard(v2.document, { anonymize: input.anonymize, language: input.language })
      return { ok: true }
    },
    generateHtmlBoardEdit: async (input: { id: string; expectedRevision: number; instruction: string; requestId: string }) => {
      v2.aiCalls++; v2.aiInput = structuredClone(input)
      if (v2.aiMode === 'fail') return { ok: false, error: 'failed' }
      if (v2.aiMode === 'pending') return new Promise(resolve => { v2.aiResolve = resolve })
      if (!v2.document || v2.document.revision !== input.expectedRevision) return { ok: false, error: 'conflict' }
      const html = v2.document.html.replace('Weekly report', 'AI fixture title').replace('<div data-reading-slot></div>', '<p class="ai-kpi">AI KPI <span data-reading-value="1.spend"></span></p><div data-reading-chart="spend"></div><div data-reading-slot></div>')
      return { ok: true, proposal: { html, css: v2.document.css, theme: 'operations', baseRevision: input.expectedRevision } }
    },
    cancelHtmlBoardEdit: async (_requestId: string) => { v2.aiCancels++; if (!v2.aiResolve) return false; const resolve = v2.aiResolve; v2.aiResolve = undefined; resolve({ ok: false, error: 'cancelled' }); return true },
    getBoardHighlightEvidence: async (input: { boardId: string; widgetId: string }) => {
      const widget = saved.find(board => board.id === input.boardId)?.widgets.find(item => item.id === input.widgetId)
      const snapshot = widget?.config.snapshot as HtmlBoardDocument['snapshot'] | undefined
      if (!snapshot) return { ok: false, error: 'not-found' }
      v2.evidence = { boardId: input.boardId, widgetId: input.widgetId, revision, capturedAt: snapshot.capturedAt, omittedCount: 0, accounts: snapshot.accounts.map((account, index) => ({ index: index + 1, name: account.name, accountId: account.accountId, resultType: account.resultType ?? null, platform: account.platform, status: account.status, window: account.window, previousWindow: account.previousWindow, sourceAt: account.sourceAt, currency: account.currency, metrics: { spend: account.spend, previousSpend: account.previousSpend, impressions: account.impressions, clicks: account.clicks, conversions: account.conversions } })) }
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
    applyBoardHighlights: async () => { v2.applied++; return { ok: true } },
    getChatBoardPreview: async (_input: { sessionId: string; boardId: string; widgetId: string }) => ({ ok: true, source: 'file', boardName: 'Synthetic board', widgetTitle: 'Synthetic preview', html: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><h1>Saved synthetic visual</h1><p>42 USD</p>' }),
    checkpointList: async () => []
  },
  boardFixture: { saved, scenario, v2, buildTikTokDatasetProofs, store: useAppStore,
    setupChat: () => useAppStore.setState({ currentWorkspace: { id: 'synthetic-workspace', realPath: '/synthetic', displayPath: '/synthetic', source: 'default', createdAt: 1 }, addSession: () => {}, setCurrentSessionId: () => {}, enqueueQueuedMessage: (_id, message) => { v2.chatPrompts.push(message.text) }, drainQueuedMessage: () => true }),
    resolvePending: (id: string, value: unknown) => { const resolve = pendingRequests.get(id); pendingRequests.delete(id); resolve?.(value) } }
})
function Fixture() {
  const location = useLocation()
  const [proposal, setProposal] = useState('')
  const [chat, setChat] = useState(false)
  Object.assign((window as unknown as { boardFixture: object }).boardFixture, { showChat: () => setChat(true) })
  v2.showProposal = setProposal
  return <><div id="fixture-route">{location.pathname}</div><div id="fixture-chat"><Markdown content={proposal} />{chat && <MessageList sessionId="synthetic-chat" messages={[{ id: 'preview-tool', role: 'assistant', content: '', toolCall: { tool: 'toushou_board_add_widget', input: {}, output: JSON.stringify({ ok: true, board: { id: 'fixture-existing' }, createdWidgetId: 'fixture-clock-0' }) } }]} />}</div><BoardsPage /></>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>)
