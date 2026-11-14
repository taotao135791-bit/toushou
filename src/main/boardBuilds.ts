import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { freezeBoardBuildIntent, type BoardBuildIntent } from '../shared/boardBuild'
import { checkBoardGeneration } from '../shared/boardGeneration'
import { createWidget } from '../shared/boards'
import { boardWidgetDatasetBindings } from '../shared/boardDataWidgets'
import { adoptBoardRefreshSnapshot, getLatestBoardRefresh } from './boardRefresh'
import { boardRefreshWidgetDatasets, type BoardRefreshResult } from '../shared/boardRefresh'
import type { BoardDataset } from '../shared/types'
import { boardWidgetWindow } from '../shared/boardWindows'
import type { KanbanBoard } from '../shared/types'
import { listBoards } from './boards'
import { listDatasetsStrict } from './boardDatasets'
import { listQuerySpecs } from './integrations/appsflyer/appsflyerDataset'
import { atomicBoardFile, boardBuildRoot, boardProfileRoot, BOARD_STORE_FILES, publishBoardBuild, readBoardStoreBytes, recoverBoardBuild, withBoardBuildRoot, type BoardStoreFile } from './boardBuildStorage'

interface BuildTurn { id: string; revision: number; cwd: string; text: string; requiresBuild: boolean; readOnlyRequest: boolean; draft?: BuildDraft }
interface BuildDraft {
  id: string; root: string; profile: string; intent: BoardBuildIntent; targetBoardId?: string
  before: Record<BoardStoreFile, string | null>; boards: KanbanBoard[]; committed?: Record<string, unknown>; busy: number; sourceEvidence: Map<string, string>
}
const turns = new Map<string, BuildTurn>()

/** Called only from the trusted Main prompt entry point, never a tool. Every
 * accepted user turn invalidates old in-flight work, including steering. */
export function registerBoardBuildTurn(sessionId: string, cwd: string, text: string): void {
  const previous = turns.get(sessionId)
  if (previous?.draft && !previous.draft.busy) rmSync(previous.draft.root, { recursive: true, force: true })
  const continuation = !!previous?.requiresBuild && /^(?:继续|开始|好了|就这样|按这个|可以|重试|continue|retry)[。！!\s]*$/i.test(text.trim())
  const refreshOnly = /(?:^|[，,。\s])(?:请|帮我|再|重新)?\s*(?:刷新|更新数据|取最新|refresh)|看板\s*(?:刷新|更新)/i.test(text) && !/创建|新建|生成|搭建|添加|布局|样式|结构|定制|create|build/i.test(text)
  const editContinuation = !!previous?.requiresBuild && /背景|颜色|布局|样式|排版|改名|深色|浅色|交换|模块|style|layout|rename/i.test(text)
  const inspection = (/^(?:请|帮我|麻烦)?\s*(?:我有哪些|有哪些|有什么|列出|查看|看看|看一下|展示|显示|检查|list\b|show\b|what\b)/i.test(text.trim()) || /[?？]/.test(text)) && !/生成|创建|新建|搭建|添加|修改|改成|改为|调整|删除|删掉|移除|重命名|定制|做|建|优化|\bcreate\b|\bbuild\b|\bchange\b|\bremove\b|\bcustomize\b/i.test(text)
  turns.set(sessionId, { id: randomUUID(), revision: (previous?.revision ?? 0) + 1, cwd, text: continuation ? `${previous!.text}\n${text}` : text, readOnlyRequest: inspection || /只读|仅(?:列出|查看)|不要(?:创建|新建)|不(?:创建|新建)|read.only|list.only/i.test(text), requiresBuild: continuation || (!refreshOnly && !inspection && (/看板|(?:时钟|待办|便签)板|dashboard|\bboard\b/i.test(text) || editContinuation)) })
}
export function revokeBoardBuildSession(sessionId: string): void {
  const turn = turns.get(sessionId)
  turns.delete(sessionId)
  if (turn?.draft && !turn.draft.busy) rmSync(turn.draft.root, { recursive: true, force: true })
}
export function getBoardBuildSession(sessionId: string): { requiresBuild: boolean; cwd: string; buildId?: string; published?: boolean; intent?: BoardBuildIntent } | null {
  const turn = turns.get(sessionId)
  return turn ? { requiresBuild: turn.requiresBuild, cwd: turn.cwd, ...(turn.draft ? { buildId: turn.draft.id, published: !!turn.draft.committed, intent: structuredClone(turn.draft.intent) } : {}) } : null
}
export function hasBoardBuildTurn(sessionId: string): boolean { return turns.has(sessionId) }
const dataDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Main-native pull paths alone call this after a successful actual query. */
export function recordBoardBuildSourceEvidence(sessionId: string, kind: 'tiktok' | 'appsflyer' | 'refresh', datasetIds?: string[]): void {
  const draft = turns.get(sessionId)?.draft
  if (!draft || draft.root !== boardBuildRoot()) return
  withBoardBuildRoot(draft.root, () => {
    for (const dataset of listDatasetsStrict()) {
      if (datasetIds ? datasetIds.includes(dataset.id) : kind === 'tiktok' && dataset.name === 'TikTok 报表') draft.sourceEvidence.set(dataset.id, dataDigest(dataset))
    }
  })
}

export async function withCurrentBoardBuild<T>(sessionId: string, operation: () => Promise<T>, expectedBuildId?: unknown): Promise<T> {
  const turn = turns.get(sessionId)
  if (!turn?.requiresBuild && !turn?.draft) return operation()
  const draft = turn?.draft
  if (!draft) throw new Error('board-build-required')
  if (expectedBuildId !== draft.id || draft.committed) throw new Error('board-build-conflict')
  draft.busy++
  try {
    const result = await withBoardBuildRoot(draft.root, operation)
    if (turns.get(sessionId) !== turn) throw new Error('board-build-conflict')
    return result
  } finally {
    draft.busy--
    if (turns.get(sessionId) !== turn && !draft.busy) rmSync(draft.root, { recursive: true, force: true })
  }
}

export function beginBoardBuild(sessionId: string, cwd: string, targetBoardId?: unknown): Record<string, unknown> {
  const turn = turns.get(sessionId)
  if (!turn || turn.cwd !== cwd) return { ok: false, error: 'board-build-request-required' }
  if (!turn.text.trim() || turn.readOnlyRequest) return { ok: false, error: 'board-build-request-required' }
  if (targetBoardId !== undefined && (typeof targetBoardId !== 'string' || !targetBoardId)) return { ok: false, error: 'invalid-board-id' }
  if (turn.draft) return targetBoardId === turn.draft.targetBoardId ? buildStatus(sessionId, turn.draft.id) : { ok: false, error: 'board-build-conflict' }
  const profile = boardProfileRoot()
  recoverBoardBuild(profile)
  const boards = listBoards()
  const target = boards.find(board => board.id === targetBoardId)
  if (targetBoardId && !target) return { ok: false, error: 'board-not-found' }
  if (target?.locked) return { ok: false, error: 'board-locked' }
  // Strict reads protect corrupt user stores before any draft or journal exists.
  const datasets = listDatasetsStrict()
  const recipes = listQuerySpecs(undefined, { persistMigration: false })
  const before = readBoardStoreBytes(profile)
  const id = randomUUID(), root = path.join(profile, 'board-build-drafts', id)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[0]), before[BOARD_STORE_FILES[0]] ?? JSON.stringify({ schemaVersion: 2, boards }))
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[1]), before[BOARD_STORE_FILES[1]] ?? JSON.stringify(datasets))
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[2]), before[BOARD_STORE_FILES[2]] ?? JSON.stringify({ specs: recipes }))
  const intent = freezeBoardBuildIntent(turn.text, turn.id, turn.revision, target)
  turn.requiresBuild = true
  turn.draft = { id, root, profile, intent, ...(target ? { targetBoardId: target.id } : {}), before, boards: structuredClone(boards), busy: 0, sourceEvidence: new Map() }
  atomicBoardFile(path.join(root, 'intent.json'), JSON.stringify(intent))
  return buildStatus(sessionId, id)
}

function active(sessionId: string, buildId: unknown): { turn: BuildTurn; draft: BuildDraft } | null {
  const turn = turns.get(sessionId), draft = turn?.draft
  return turn && draft && buildId === draft.id && draft.intent.requestId === turn.id && draft.intent.revision === turn.revision ? { turn, draft } : null
}
export function buildStatus(sessionId: string, buildId?: unknown): Record<string, unknown> {
  const turn = turns.get(sessionId), draft = turn?.draft
  if (!draft) return { ok: false, error: 'board-build-required' }
  if (buildId !== undefined && buildId !== draft.id) return { ok: false, error: 'board-build-conflict' }
  return { ok: true, buildId: draft.id, draft: !draft.committed, published: !!draft.committed, intent: structuredClone(draft.intent), ...(draft.targetBoardId ? { targetBoardId: draft.targetBoardId } : {}) }
}
export function frozenBoardBuildOptions(sessionId: string, buildId: unknown): BoardBuildIntent | null {
  return active(sessionId, buildId)?.draft.intent ?? null
}

function changedBoard(draft: BuildDraft): KanbanBoard | null {
  const boards = listBoards()
  const changed = boards.filter(board => !isDeepStrictEqual(board, draft.boards.find(previous => previous.id === board.id)))
  if (changed.length !== 1 || draft.boards.some(board => !boards.some(next => next.id === board.id))) return null
  return draft.targetBoardId ? changed[0].id === draft.targetBoardId ? changed[0] : null : draft.boards.some(board => board.id === changed[0].id) ? null : changed[0]
}

function hasRequiredMeasure(board: KanbanBoard, data: BoardDataset[], intent: BoardBuildIntent, measure: NonNullable<BoardBuildIntent['measures']>[number], refresh?: BoardRefreshResult): boolean {
  const aliases = { spend: ['消耗', '花费', '费用', '媒体成本', 'spend', 'cost', 'mediacost'], conversion: ['转化', '转化次数', '转化数', 'conversion', 'conversions'], revenue: ['收入', 'revenue'] }
  const normalized = (name: string) => name.toLowerCase().replace(/[ _-]/g, '')
  const grainKeys = { account: ['advertiserid', 'accountid', '广告主id', '账户id'], campaign: ['campaignid', '活动id', '广告系列id'], adgroup: ['adgroupid', 'adsetid', '广告组id', '广告集id'], ad: ['adid', '广告id'], creative: ['creativeid', 'materialid', 'assetid', '素材id', '创意id'] }
  const grains = intent.options.granularity === undefined ? [] : typeof intent.options.granularity === 'string' ? [intent.options.granularity] : [...intent.options.granularity]
  return board.widgets.some(widget => {
    const datasets = refresh ? boardRefreshWidgetDatasets(refresh, widget, data) : data
    const bindings = boardWidgetDatasetBindings(widget)
    if (widget.type === 'tt-reading') bindings.push({ source: 'dataset', datasetId: 'TikTok 报表' })
    return bindings.some(binding => {
      const dataset = datasets.find(item => item.id === binding.datasetId || item.name === binding.datasetId)
      if (!dataset) return false
      const visible = widget.type === 'table' ? Array.isArray(widget.config.columns) ? widget.config.columns as string[] : dataset.columns.map(column => column.name) : widget.type === 'tt-reading' ? dataset.columns.map(column => column.name).filter(name => !Object.values(grainKeys).flat().includes(normalized(name))) : [binding.metric, widget.config.dimension].filter((name): name is string => typeof name === 'string')
      const metric = dataset.columns.findIndex(column => visible.includes(column.name) && column.type === 'number' && aliases[measure].includes(normalized(column.name)))
      if (metric < 0) return false
      const ids = dataset.columns.flatMap((column, index) => visible.includes(column.name) && grains.some(grain => grainKeys[grain].includes(normalized(column.name))) ? [index] : [])
      const window = boardWidgetWindow(board, widget), date = dataset.columns.findIndex(column => column.type === 'date')
      const filter = binding.filterColumn ? dataset.columns.findIndex(column => column.name === binding.filterColumn) : -1
      const values = binding.filterValues ?? (binding.filterValue ? [binding.filterValue] : [])
      return dataset.rows.some(row => typeof row[metric] === 'number' && Number.isFinite(row[metric]) && (date < 0 || String(row[date]) >= window.start && String(row[date]) <= window.end) && (!binding.filterColumn || !values.length || filter >= 0 && values.includes(String(row[filter]))) && (!grains.length || ids.some(index => typeof row[index] === 'number' ? Number.isSafeInteger(row[index]) && Number(row[index]) > 0 : typeof row[index] === 'string' && !['', '0', 'null', 'none', 'all', '—'].includes(String(row[index]).trim().toLowerCase()))))
    })
  })
}

export function checkFrozenBoardBuild(sessionId: string, buildId: unknown, feasibility = false): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state) return { ok: false, error: 'board-build-conflict' }
  const { draft } = state
  const inspect = (): Record<string, unknown> => {
    const data = listDatasetsStrict(), recipes = listQuerySpecs(undefined, { persistMigration: false })
    let board = changedBoard(draft)
    if (feasibility && !board && draft.intent.mode === 'presentation') board = draft.boards.find(item => item.id === draft.targetBoardId) ?? null
    if (feasibility && !board) {
      board = { id: 'feasibility', name: 'Data feasibility', createdAt: 0, updatedAt: 0, widgets: data.map((dataset, index) => createWidget('table', '', { x: 0, y: index * 4 }, { source: 'dataset', datasetId: dataset.id })), ...(draft.intent.range ? { masterScope: { range: draft.intent.range, metrics: ['spend'] } } : {}) }
    }
    if (!board) return { ok: false, error: 'board-build-target-required', buildId: draft.id, published: false }
    const presentation = draft.intent.mode === 'presentation'
    const options = feasibility ? { ...draft.intent.options, mode: 'custom' as const, required: presentation || draft.intent.mode === 'snapshot' ? [] : ['data'] as const, daily: false } : draft.intent.options
    const refresh = getLatestBoardRefresh(board)
    const check = checkBoardGeneration(board, data, options, recipes, Date.now(), refresh)
    const issues = [...check.issues]
    if (!feasibility) for (const type of draft.intent.utilityTypes ?? []) if (!board.widgets.some(widget => widget.type === type)) issues.push({ code: `intent-utility-missing:${type}` })
    if (!feasibility) for (const measure of draft.intent.measures ?? []) if (!hasRequiredMeasure(board, data, draft.intent, measure, refresh)) issues.push({ code: `intent-measure-missing:${measure}` })
    for (const reason of draft.intent.unresolved ?? []) issues.push({ code: `intent-unresolved:${reason}` })
    if (draft.intent.range && board.masterScope?.range !== draft.intent.range) issues.push({ code: 'intent-date-scope-mismatch' })
    if (draft.intent.fixedValues) {
      const values = board.widgets.filter(widget => widget.type === 'counter' && widget.config.source !== 'dataset').map(widget => widget.config.value).sort((a, b) => Number(a) - Number(b))
      if (!isDeepStrictEqual(values, [...draft.intent.fixedValues].sort((a, b) => a - b))) issues.push({ code: 'intent-fixed-values-mismatch' })
    }
    if (presentation) {
      const previous = draft.boards.find(item => item.id === board.id)
      const removed = previous?.widgets.filter(widget => !board!.widgets.some(next => next.id === widget.id)).map(widget => widget.id).sort() ?? []
      const added = board.widgets.filter(widget => !previous?.widgets.some(old => old.id === widget.id)).map(widget => widget.type).sort()
      if (!isDeepStrictEqual(added, [...(draft.intent.addedUtilityTypes ?? [])].sort())) issues.push({ code: 'presentation-unrequested-addition' })
      if (!previous || !isDeepStrictEqual(removed, [...(draft.intent.removedWidgetIds ?? [])].sort()) || board.widgets.some(widget => {
        const old = previous.widgets.find(item => item.id === widget.id)
        return old ? old.type !== widget.type || !isDeepStrictEqual(old.config, widget.config) || !isDeepStrictEqual(old.dateScope, widget.dateScope) : !['clock', 'note', 'todo', 'link'].includes(widget.type)
      }) || !isDeepStrictEqual(previous.masterScope, board.masterScope)) issues.push({ code: 'presentation-changed-data-binding' })
      const now = readBoardStoreBytes(draft.committed ? draft.profile : draft.root)
      if (!isDeepStrictEqual(JSON.parse(now[BOARD_STORE_FILES[1]] ?? '[]'), JSON.parse(draft.before[BOARD_STORE_FILES[1]] ?? '[]'))) issues.push({ code: 'presentation-changed-data' })
      if (!isDeepStrictEqual(JSON.parse(now[BOARD_STORE_FILES[2]] ?? '{"specs":[]}'), JSON.parse(draft.before[BOARD_STORE_FILES[2]] ?? '{"specs":[]}'))) issues.push({ code: 'presentation-changed-query' })
    }
    if (!presentation && draft.intent.mode !== 'snapshot') {
      const previous = draft.boards.find(item => item.id === board.id)
      for (const widget of board.widgets) {
        if (!['counter', 'gauge', 'chart-line', 'chart-bar', 'reading-module', 'reading-snapshot'].includes(widget.type) || widget.config.source === 'dataset') continue
        const original = previous?.widgets.find(item => item.id === widget.id)
        if (draft.intent.requireLiveBindings || !original || original.type !== widget.type || !isDeepStrictEqual(original.config, widget.config)) issues.push({ code: 'fixed-value-requires-explicit-snapshot', widgetId: widget.id })
      }
    }
    if (!presentation && draft.intent.mode !== 'snapshot') {
      const ids = new Set(board.widgets.flatMap(widget => boardWidgetDatasetBindings(widget).map(binding => binding.datasetId)))
      if (board.widgets.some(widget => widget.type === 'tt-reading')) ids.add('TikTok 报表')
      for (const id of ids) {
        const dataset = data.find(item => item.id === id || item.name === id)
        const actualRead = refresh?.status === 'ready' && refresh.widgets.some(widget => widget.bindings.some(binding => {
          if (binding.datasetId !== id && binding.datasetId !== dataset?.id && binding.datasetId !== dataset?.name) return false
          const source = refresh.sources.find(item => item.key === binding.sourceKey)
          return !!source?.dataset && source.kind !== 'dataset' && (source.status === 'updated' || source.status === 'empty')
        }) || (id === 'TikTok 报表' && !!widget.nativeSourceKey && refresh.sources.some(source => source.key === widget.nativeSourceKey && source.kind === 'tiktok' && source.status === 'updated')))
        if (dataset && !actualRead && draft.sourceEvidence.get(dataset.id) !== dataDigest(dataset)) issues.push({ code: 'source-query-evidence-required', datasetId: dataset.id })
      }
    }
    const passed = check.status === 'ready' && issues.length === 0
    return { ...check, status: check.missing.length ? 'incomplete' : issues.length ? 'needs-attention' : 'ready', issues, ok: passed, passed, ...(passed ? {} : { error: feasibility ? 'board-data-not-feasible' : 'board-incomplete' }), buildId: draft.id, boardId: board.id, draft: !draft.committed, published: !!draft.committed,
      ...(feasibility && !passed ? { hint: '当前数据或已接入适配器尚不能证明本次要求；这不代表媒体平台本身不支持。请在草稿补齐真实数据或说明受阻，不能自动降级后发布。' } : {}) }
  }
  return draft.committed ? inspect() : withBoardBuildRoot(draft.root, inspect)
}

export function commitBoardBuild(sessionId: string, buildId: unknown, stillAuthorized: () => boolean): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state) return { ok: false, error: 'board-build-conflict' }
  const { draft } = state
  if (draft.committed) return draft.committed
  if (draft.busy) return { ok: false, error: 'board-build-busy' }
  const check = checkFrozenBoardBuild(sessionId, buildId)
  if (!check.passed) return check
  if (!stillAuthorized() || active(sessionId, buildId)?.draft !== draft) return { ok: false, error: 'permission-denied' }
  // Conservative whole-store CAS also catches source-cache changes and other
  // boards changed during generation. No unrelated user write is overwritten.
  if (!isDeepStrictEqual(readBoardStoreBytes(draft.profile), draft.before)) return { ok: false, error: 'conflict', buildId: draft.id }
  const after = readBoardStoreBytes(draft.root)
  const board = withBoardBuildRoot(draft.root, () => changedBoard(draft))!
  const refresh = withBoardBuildRoot(draft.root, () => getLatestBoardRefresh(board))
  publishBoardBuild(draft.profile, draft.before, after)
  const refreshAdopted = refresh ? adoptBoardRefreshSnapshot(board, refresh) : undefined
  draft.committed = { ok: true, published: true, draft: false, buildId: draft.id, board, check, ...(refreshAdopted !== undefined ? { refreshAdopted } : {}) }
  rmSync(draft.root, { recursive: true, force: true })
  return draft.committed
}
export function abortBoardBuild(sessionId: string, buildId: unknown): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state || state.draft.committed) return { ok: false, error: 'board-build-conflict' }
  if (state.draft.busy) return { ok: false, error: 'board-build-busy' }
  rmSync(state.draft.root, { recursive: true, force: true })
  delete state.turn.draft
  return { ok: true, aborted: true, published: false }
}
