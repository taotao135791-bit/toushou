import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { abortBoardBuild, beginBoardBuild, buildStatus, checkFrozenBoardBuild, commitBoardBuild, getBoardBuildSession, hasBoardBuildTurn, recordBoardBuildSourceEvidence, withCurrentBoardBuild } from './boardBuilds'
import { validateWidgetDateScope } from '../shared/boardWindows'
import { readBoardMetaAccounts, refreshBoard } from './boardRefresh'
import { boardBuildRoot } from './boardBuildStorage'
import { boardWidgetDatasetBindings } from '../shared/boardDataWidgets'
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { DATASET_LIMITS } from '../shared/datasets'
import type { PermissionMode } from '../shared/types'
import { parseTikTokAdvertiserIdList } from '../shared/tiktokReport'
import { serializeBoundedJson } from '../shared/boundedJson'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import { getBoardHighlightEvidence } from './boardHighlights'
import { checkBoardGeneration, parseBoardGenerationOptions } from '../shared/boardGeneration'
import { listBoards, peekBoardsForConfirmation, saveBoard } from './boards'
import { pruneHtmlBoardsForBoard } from './htmlBoards'
import { listDatasets } from './boardDatasets'
import { isAppsFlyerBuiltInEvent } from './integrations/appsflyer/AppsFlyerMcpClient'
import {
  BOARD_LIMITS,
  WIDGET_DEFAULT_SIZES,
  WIDGET_TYPES,
  composeBoard,
  createWidget,
  applyMasterScope,
  detectPreset,
  findFreeSlot,
  validateBoard,
  validateBoardStyle,
  validateBoardWidgetStyle,
  validateMasterScope,
  type BoardPresetId,
  type BoardText
} from '../shared/boards'
import type { BoardStyle, BoardWidget, BoardWidgetLayout, BoardWidgetStyle, KanbanBoard, WidgetType } from '../shared/types'

/**
 * Loopback bridge for the bundled boards toolkit: the OMP extension registers
 * toushou_boards_* tools and calls back into Main over this server. Boards are
 * the app's LOCAL canvas — the agent may list, inspect, create and reshape
 * them directly (the user asked for zero-friction board operations with a
 * done-report), while the ad platforms themselves stay strictly read-only:
 * nothing here ever reaches TikTok/FB/Google.
 *
 * Every write re-validates the whole board through saveBoard's strict
 * validator, so an out-of-domain widget config is rejected atomically.
 */

const MAX_BODY_BYTES = 64 * 1024
export const BOARDS_TOOLS_ENV_KEY = 'TOUSHOU_BOARDS'

/** Main-side zh display text for the shared board presets (Main cannot import
 *  the renderer i18n; connection labels already follow this zh-first rule). */
const BOARD_TEXT: Record<string, string> = {
  'boards.preset.meta': 'Meta Ads 投放看板',
  'boards.preset.meta.spend': '总消耗',
  'boards.preset.meta.impressions': '总展示',
  'boards.preset.meta.clicks': '总点击',
  'boards.preset.meta.dailySpend': '每日消耗趋势',
  'boards.preset.meta.accountSpend': '分账户消耗',
  'boards.preset.meta.source': '数据来源与范围',
  'boards.preset.meta.sourceBody': '来源：Pipeboard Meta Ads MCP。在 Meta 读数模块加载并选择已授权账户，刷新和总控日期切换会读取每日明细，联动指标卡与趋势图。缺失指标不补零；未返回的账户时区标为待确认。',
  'boards.widget.clock': '时钟',
  'boards.widget.note': '便签',
  'boards.widget.todo': '待办清单',
  'boards.widget.fb-reading': 'FB 读数',
  'boards.widget.fb-reading-summary': 'FB 读数汇总',
  'boards.widget.fb-report-reading': 'FB 报表读数',
  'boards.widget.tt-reading': 'TT 读数',
  'boards.widget.meta-reading': 'Meta 读数',
  'boards.reading.ttModuleName': 'TT 读数',
  'boards.preset.ads': '海外广告投放',
  'boards.preset.ads.kpiSpend': '今日消耗 ($)',
  'boards.preset.ads.kpiImpressions': '展示次数',
  'boards.preset.ads.kpiClicks': '点击次数',
  'boards.preset.ads.kpiConversions': '转化次数',
  'boards.preset.ads.trend': '分日消耗趋势',
  'boards.preset.ads.channels': '分渠道消耗对比',
  'boards.preset.ads.budget': '预算达成率',
  'boards.preset.ads.budgetLabel': '月度预算',
  'boards.preset.ads.todo': '投放优化清单',
  'boards.preset.ads.todoSearchTerms': '搜索词报告否词检查',
  'boards.preset.ads.todoCreatives': '低效素材迭代',
  'boards.preset.ads.todoBudget': '预算重分配',
  'boards.preset.ads.todoTracking': '转化追踪核对',
  'boards.preset.ads.note': '投放笔记',
  'boards.preset.finance': '财经行情',
  'boards.preset.finance.kpi': '最新价',
  'boards.preset.finance.trend': '价格走势',
  'boards.preset.daily': '日常通用',
  'boards.preset.fbDaily': 'FB 投放日报',
  'boards.preset.fbDaily2': 'FB 投放日报',
  'boards.preset.tiktok': 'TikTok 投放全景',
  'boards.preset.tiktok.kpiSpend': '总消耗',
  'boards.preset.tiktok.kpiClicks': '总点击',
  'boards.preset.tiktok.kpiCtr': '平均点击率',
  'boards.preset.tiktok.kpiConversions': '总转化',
  'boards.preset.tiktok.spendTrend': '近 30 天消耗趋势',
  'boards.preset.tiktok.campaignSpend': '分活动消耗对比',
  'boards.preset.tiktok.conversionTrend': '转化趋势',
  'boards.preset.tiktok.note': '数据来源与刷新',
  'boards.preset.tiktok.noteBody':
    '数据来源：数据集「TikTok 报表」（支持 CSV/XLSX 导入）。指标卡与图表按绑定字段自动汇总；重新导入数据集后，看板各模块随之刷新。'
}
const boardText: BoardText = (key) => BOARD_TEXT[key] ?? key

export const BOARD_TEMPLATES: readonly BoardPresetId[] = [
  'tiktok',
  'meta',
  'fb-daily-v2',
  'ads',
  'daily',
  'blank'
]

const WIDGET_TITLE_ZH: Record<WidgetType, string> = {
  clock: '时钟',
  note: '便签',
  counter: '指标卡',
  'fb-reading': 'FB 读数',
  'fb-reading-summary': 'FB 读数汇总',
  'fb-report-reading': 'FB 报表读数',
  'google-report-reading': 'Google 读数',
  'tt-reading': 'TT 读数',
  'meta-reading': 'Meta 读数',
  'reading-snapshot': '读数快照',
  'reading-module': '读数组件',
  gauge: '仪表',
  'chart-line': '折线图',
  'chart-bar': '柱状图',
  table: '数据表格',
  funnel: '业务漏斗',
  todo: '待办清单',
  link: '链接',
  file: '文件',
  analysis: '业务分析'
}

export type BoardsBridgeRequest = (
  | { action: 'board_build_begin'; targetBoardId?: unknown }
  | { action: 'board_build_status' }
  | { action: 'board_build_preflight' }
  | { action: 'board_build_commit' }
  | { action: 'board_build_abort' }
  | { action: 'board_refresh'; boardId?: unknown }
  | { action: 'board_meta_accounts' }
  | { action: 'boards_list' }
  | { action: 'board_get'; boardId?: unknown; name?: unknown }
  | { action: 'board_check'; boardId?: unknown; name?: unknown; mode?: unknown; required?: unknown; daily?: unknown; granularity?: unknown; dimensions?: unknown }
  | {
      action: 'board_create'
      name?: unknown
      template?: unknown
      description?: unknown
      advertiserIds?: unknown
      advertiserName?: unknown
      advertiserNames?: unknown
      style?: unknown
      masterScope?: unknown
    }
  | { action: 'board_add_widget'; boardId?: unknown; name?: unknown; type?: unknown; title?: unknown; config?: unknown; source?: unknown; layout?: unknown; style?: unknown; dateScope?: unknown }
  | { action: 'board_remove_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown }
  | { action: 'board_update_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown; title?: unknown; config?: unknown; layout?: unknown; style?: unknown; dateScope?: unknown }
  | { action: 'board_customize'; version?: unknown; boardId?: unknown; name?: unknown; expectedUpdatedAt?: unknown; preview?: unknown; style?: unknown; masterScope?: unknown; widgets?: unknown }
  | { action: 'board_rename'; boardId?: unknown; name?: unknown; newName?: unknown }
  | { action: 'dataset_import'; filePath?: unknown; name?: unknown }
  | { action: 'af_dataset_pull'; name?: unknown; appId?: unknown; eventName?: unknown; days?: unknown; startDate?: unknown; endDate?: unknown; basis?: unknown; metrics?: unknown; groupings?: unknown; geo?: unknown; countries?: unknown; mediaSources?: unknown }
) & { buildId?: unknown }

function boundedString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean.length > 0 && clean.length <= max ? clean : null
}

const CANVAS_STYLE_KEYS = ['background', 'grid'] as const
const WIDGET_STYLE_KEYS = ['accent', 'surface', 'text', 'border', 'radius', 'padding', 'titleAlign', 'shadow'] as const
type StylePatch<T> = { ok: true; value: T | undefined } | { ok: false }

/** Styling is a bounded token patch, never CSS or a new renderer capability. */
function mergeStyle<T extends object>(raw: unknown, current: T | undefined, keys: readonly string[], validate: (value: unknown) => T | undefined): StylePatch<T> {
  if (raw === null) return { ok: true, value: undefined }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  if (Object.keys(raw).some(key => !keys.includes(key))) return { ok: false }
  if (Object.keys(raw).length === 0) return { ok: true, value: current }
  const value = validate({ ...current, ...raw })
  return value ? { ok: true, value } : { ok: false }
}

function preciseLayout(raw: unknown): BoardWidgetLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['x', 'y', 'w', 'h'].includes(key))) return null
  if (!['x', 'y', 'w', 'h'].every(key => Number.isSafeInteger(value[key]))) return null
  const { x, y, w, h } = value as unknown as BoardWidgetLayout
  if (x < 0 || y < 0 || y > BOARD_LIMITS.maxWidgets * 20 || w < 1 || w > 12 || x + w > 12 || h < 1 || h > 20) return null
  return { x, y, w, h }
}

function intersects(left: BoardWidgetLayout, right: BoardWidgetLayout): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y
}

function movedWidgetsOverlap(widgets: BoardWidget[], movedIds: Set<string>): boolean {
  return widgets.some((left, i) => widgets.slice(i + 1).some(right =>
    (movedIds.has(left.id) || movedIds.has(right.id)) && intersects(left.layout, right.layout)
  ))
}

export function parseBoardsBridgeRequest(raw: unknown): BoardsBridgeRequest | null {
  const parsed = parseBoardsBridgeAction(raw)
  return parsed && raw && typeof raw === 'object' ? { ...parsed, buildId: (raw as Record<string, unknown>).buildId } : null
}
function parseBoardsBridgeAction(raw: unknown): BoardsBridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  switch (value.action) {
    case 'board_build_begin':
      return { action: 'board_build_begin', targetBoardId: value.targetBoardId }
    case 'board_build_status': case 'board_build_preflight': case 'board_build_commit': case 'board_build_abort':
      return { action: value.action }
    case 'board_refresh':
      return { action: 'board_refresh', boardId: value.boardId }
    case 'board_meta_accounts':
      return { action: 'board_meta_accounts' }
    case 'boards_list':
      return { action: 'boards_list' }
    case 'board_get':
      return { action: 'board_get', boardId: value.boardId, name: value.name }
    case 'board_check':
      return { action: 'board_check', boardId: value.boardId, name: value.name, mode: value.mode, required: value.required, daily: value.daily, granularity: value.granularity, dimensions: value.dimensions }
    case 'board_create':
      return {
        action: 'board_create',
        name: value.name,
        template: value.template,
        description: value.description,
        advertiserIds: value.advertiserIds,
        advertiserName: value.advertiserName,
        advertiserNames: value.advertiserNames,
        style: value.style,
        masterScope: value.masterScope
      }
    case 'board_add_widget':
      return {
        action: 'board_add_widget',
        boardId: value.boardId,
        name: value.name,
        type: value.type,
        title: value.title,
        config: value.config,
        source: value.source,
        layout: value.layout,
        style: value.style,
        dateScope: value.dateScope
      }
    case 'board_remove_widget':
      return { action: 'board_remove_widget', boardId: value.boardId, name: value.name, widgetId: value.widgetId }
    case 'board_update_widget':
      return {
        action: 'board_update_widget',
        boardId: value.boardId,
        name: value.name,
        widgetId: value.widgetId,
        title: value.title,
        config: value.config,
        layout: value.layout,
        style: value.style,
        dateScope: value.dateScope
      }
    case 'board_customize':
      return { action: 'board_customize', version: value.version, boardId: value.boardId, name: value.name, expectedUpdatedAt: value.expectedUpdatedAt, preview: value.preview, style: value.style, masterScope: value.masterScope, widgets: value.widgets }
    case 'board_rename':
      return { action: 'board_rename', boardId: value.boardId, name: value.name, newName: value.newName }
    case 'dataset_import':
      return { action: 'dataset_import', filePath: value.filePath, name: value.name }
    case 'af_dataset_pull':
      return { action: 'af_dataset_pull', name: value.name, appId: value.appId, eventName: value.eventName, days: value.days, startDate: value.startDate, endDate: value.endDate, basis: value.basis, metrics: value.metrics, groupings: value.groupings, geo: value.geo, countries: value.countries, mediaSources: value.mediaSources }
    default:
      return null
  }
}

let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()

export function initBoardsBridge(): Promise<void> {
  if (port !== null) return Promise.resolve()
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const server = createServer((request, response) => void handle(request, response))
    const fail = (error: Error) => {
      port = null
      ready = null
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return fail(new Error('boards bridge did not receive a port'))
      port = address.port
      resolve()
    })
  })
  return ready
}

/** Per-session loopback URL injected into the OMP process env. */
export function boardsBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  if (tokens.size >= 200) {
    const oldest = tokens.keys().next().value
    if (oldest !== undefined) tokens.delete(oldest)
  }
  tokens.set(token, sessionId)
  return { [BOARDS_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
}

/** Free every token minted for a session — wired to the 'closed' event so a
 *  long-lived app never evicts a STILL-RUNNING session's tools at the cap. */
export function revokeBoardsBridgeTokens(sessionId: string): void {
  for (const [token, owner] of tokens) {
    if (owner === sessionId) tokens.delete(token)
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = (request.url ?? '').replace(/^\//, '')
  const sessionId = tokens.get(token)
  if (request.method !== 'POST' || !sessionId) return json(response, 403, { ok: false, error: 'forbidden' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return json(response, 413, { ok: false, error: 'request-too-large' })
    chunks.push(buffer)
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return json(response, 400, { ok: false, error: 'bad-json' })
  }
  const tool = parseBoardsBridgeRequest(raw)
  if (!tool) return json(response, 400, { ok: false, error: 'unsupported-action' })
  try {
    return json(response, 200, await authorizeAndDispatch(sessionId, tool))
  } catch {
    return json(response, 200, { ok: false, error: 'store-unreadable' })
  }
}

function findBoard(tool: { boardId?: unknown; name?: unknown }): KanbanBoard | null {
  const boards = listBoards()
  const id = typeof tool.boardId === 'string' ? tool.boardId : null
  if (id) return boards.find((board) => board.id === id) ?? null
  const name = boundedString(tool.name, BOARD_LIMITS.maxNameLength)
  if (!name) return null
  const lower = name.toLowerCase()
  return boards.find((board) => board.name.toLowerCase() === lower) ?? null
}

function modelBoardName(board: KanbanBoard): string { return board.name }

function boardSummary(board: KanbanBoard): Record<string, unknown> {
  return {
    id: board.id,
    name: modelBoardName(board),
    locked: board.locked === true,
    widgetCount: board.widgets.length,
    updatedAt: board.updatedAt,
    ...(board.style ? { style: { ...board.style } } : {}),
    ...(board.masterScope ? { masterScope: structuredClone(board.masterScope) } : {}),
    widgets: board.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      title: widget.title,
      layout: { ...widget.layout },
      ...(widget.style ? { style: { ...widget.style } } : {}),
      ...(widget.dateScope ? { dateScope: structuredClone(widget.dateScope) } : {}),
      config: widget.type === 'reading-snapshot' ? readingSnapshotSummary(board, widget.id, widget.config) : widget.type === 'reading-module' ? { accountCount: validateReadingSnapshot(widget.config.snapshot)?.accounts.length ?? 0, module: widget.config.module } : widget.config
    }))
  }
}

function persistedBoardSummary(board: KanbanBoard): Record<string, unknown> {
  return boardSummary(listBoards().find(item => item.id === board.id) ?? board)
}

/** Model-facing board reads use a bounded snapshot projection and omit provider errors. */
function readingSnapshotSummary(board: KanbanBoard, widgetId: string, config: Record<string, unknown>): Record<string, unknown> {
  const snapshot = validateReadingSnapshot(config.snapshot)
  if (!snapshot) return { unavailable: true }
  const result = getBoardHighlightEvidence({ boardId: board.id, widgetId }, { list: () => [board] })
  return result.ok ? { accountCount: snapshot.accounts.length, evidence: result.evidence } : { unavailable: true }
}

function datasetsOverview(): Array<Record<string, unknown>> {
  return listDatasets().filter(dataset => !dataset.appsflyer?.materialization).map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    rowCount: dataset.rows.length,
    columns: dataset.columns.map((column) => ({ name: column.name, type: column.type }))
  }))
}

function bindsInternalDataset(widget: BoardWidget): boolean {
  const ids = new Set(boardWidgetDatasetBindings(widget).map(binding => binding.datasetId))
  return listDatasets().some(dataset => !!dataset.appsflyer?.materialization && (ids.has(dataset.id) || ids.has(dataset.name)))
}

export interface BoardsSessionAccess { cwd: string; mode: PermissionMode; remoteReadonly: boolean }
export interface BoardsAuthorizationDeps {
  getAccess: (sessionId: string) => BoardsSessionAccess | null
  confirm: (tool: BoardsBridgeRequest) => Promise<boolean>
}

/** Display-only lookup: boardId still controls the operation and is retained in details. */
export function boardConfirmationDetails(request: BoardsBridgeRequest, readBoards: () => KanbanBoard[] = peekBoardsForConfirmation): string {
  const details = Object.entries(request).filter(([key]) => ['boardId', 'name', 'newName', 'widgetId', 'title', 'type', 'filePath'].includes(key))
    .flatMap(([key, value]) => typeof value === 'string' ? [`${key}: ${value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240)}`] : [])
  if ((request.action === 'board_add_widget' || request.action === 'board_customize') && typeof request.boardId === 'string' && request.boardId) {
    try {
      const board = readBoards().find(item => item.id === request.boardId)
      if (board) details.unshift(`看板: ${board.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240)}`)
    } catch { /* Never guess a name when the board store cannot be read. */ }
  }
  if (request.action === 'board_customize' && Array.isArray(request.widgets)) details.push(`修改组件: ${request.widgets.length}`)
  return details.join('\n')
}

/** Main enforces authority even if an extension bypasses its tool approval metadata. */
export async function authorizeAndDispatch(
  sessionId: string,
  tool: BoardsBridgeRequest,
  deps?: BoardsAuthorizationDeps
): Promise<Record<string, unknown>> {
  const getAccess = deps?.getAccess ?? (await import('./omp')).getSessionBridgeAccess
  const access = getAccess(sessionId)
  if (!access) return { ok: false, error: 'no-session' }
  const write = !['boards_list', 'board_get', 'board_check', 'board_meta_accounts', 'board_build_status', 'board_build_preflight'].includes(tool.action) && !(tool.action === 'board_customize' && tool.preview !== false)
  if (write && (access.remoteReadonly || !['full', 'no-bash', 'ask'].includes(access.mode))) return { ok: false, error: 'permission-denied' }
  if (write && access.mode === 'ask') {
    const confirm = deps?.confirm ?? (async (request: BoardsBridgeRequest) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!win || win.isDestroyed()) return false
      const labels: Record<string, string> = {
        board_create: '新建看板', board_rename: '重命名看板', board_add_widget: '添加组件',
        board_update_widget: '修改组件', board_remove_widget: '移除组件', board_customize: '定制看板样式与结构', dataset_import: '导入数据集'
      }
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: '确认看板操作',
        message: `允许此会话${labels[request.action] ?? '修改本地看板'}？`,
        detail: boardConfirmationDetails(request),
        buttons: ['拒绝', '允许一次'], defaultId: 0, cancelId: 0, noLink: true
      })
      return result.response === 1
    })
    if (!(await confirm(tool))) return { ok: false, error: 'permission-denied' }
    const current = getAccess(sessionId)
    if (!current || current.remoteReadonly || !['full', 'no-bash', 'ask'].includes(current.mode) || current.cwd !== access.cwd) return { ok: false, error: 'permission-denied' }
  }
  const stillAuthorized = (): boolean => {
    const current = getAccess(sessionId)
    return Boolean(current && !current.remoteReadonly && ['full', 'no-bash', 'ask'].includes(current.mode) && current.cwd === access.cwd && (current.mode !== 'ask' || access.mode === 'ask'))
  }
  const state = getBoardBuildSession(sessionId)
  if (state?.buildId && state.cwd !== access.cwd) return { ok: false, error: 'board-build-conflict' }
  if (tool.action === 'board_build_begin') return beginBoardBuild(sessionId, access.cwd, tool.targetBoardId)
  if (tool.action === 'board_build_status') return buildStatus(sessionId, tool.buildId)
  if (tool.action === 'board_build_preflight') return checkFrozenBoardBuild(sessionId, tool.buildId, true)
  if (tool.action === 'board_build_commit') {
    const result = commitBoardBuild(sessionId, tool.buildId, stillAuthorized)
    return result.board ? { ...result, board: boardSummary(result.board as KanbanBoard) } : result
  }
  if (tool.action === 'board_build_abort') return abortBoardBuild(sessionId, tool.buildId)
  if (tool.action === 'board_meta_accounts') return { ...(await readBoardMetaAccounts()) }
  const boardRead = tool.action === 'boards_list' || tool.action === 'board_get' || tool.action === 'board_check'
  if (boardRead && tool.buildId === undefined) return dispatch(tool, access.cwd)
  if (boardRead && !state?.buildId) return { ok: false, error: 'board-build-conflict' }
  const boardWrite = ['board_create', 'board_add_widget', 'board_update_widget', 'board_remove_widget', 'board_customize', 'board_rename'].includes(tool.action)
  // deps without a trusted turn are a legacy unit-test seam. Production never
  // receives requirements or authority from this seam or from model arguments.
  if (boardWrite && (!deps || hasBoardBuildTurn(sessionId)) && !state?.buildId) return { ok: false, error: 'board-build-required' }
  if (state?.buildId && tool.action === 'board_check') return checkFrozenBoardBuild(sessionId, tool.buildId)
  if (state?.published && (tool.action === 'board_get' || tool.action === 'boards_list')) {
    if (tool.buildId !== undefined && tool.buildId !== state.buildId) return { ok: false, error: 'board-build-conflict' }
    return dispatch(tool, access.cwd)
  }
  const inDraft = !!state?.buildId
  try {
    const result = await withCurrentBoardBuild(sessionId, async () => {
      if (tool.action === 'board_refresh') {
        if (typeof tool.boardId !== 'string') return { ok: false, error: 'invalid-board-id' }
        const refreshed = await refreshBoard({ boardId: tool.boardId }, { stillAuthorized })
        const ids = refreshed.sources.filter(source => ['updated', 'empty'].includes(source.status) && source.kind !== 'dataset').flatMap(source => source.dataset ? [source.dataset.id] : [])
        if (ids.length) recordBoardBuildSourceEvidence(sessionId, 'refresh', ids)
        return { ...refreshed }
      }
      const result = await dispatch(tool, access.cwd, write ? stillAuthorized : undefined)
      if (tool.action === 'af_dataset_pull' && result.ok === true && result.dataset && typeof result.dataset === 'object') {
        const id = (result.dataset as { id?: unknown }).id
        if (typeof id === 'string') recordBoardBuildSourceEvidence(sessionId, 'appsflyer', [id])
      }
      return result
    }, tool.buildId)
    return inDraft ? { ...result, draft: true, published: false, buildId: state!.buildId } : result
  } catch (error) {
    if (error instanceof Error && ['board-build-required', 'board-build-conflict'].includes(error.message)) return { ok: false, error: error.message }
    throw error
  }
}

/** Open and pin a workspace file before parsing; never reopen the supplied path. */
export function readWorkspaceDataset(raw: unknown, cwd: string): { name: string; bytes: Buffer } | null {
  if (typeof raw !== 'string' || !raw || /[\x00-\x1f\x7f]/.test(raw)) return null
  let fd: number | undefined
  try {
    const root = realpathSync(cwd)
    if (!statSync(root).isDirectory()) return null
    const source = path.resolve(root, raw)
    const real = realpathSync(source)
    const relative = path.relative(root, real)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const current = statSync(real)
    if (!opened.isFile() || opened.size > DATASET_LIMITS.maxFileBytes || opened.dev !== current.dev || opened.ino !== current.ino || realpathSync(source) !== real) return null
    const buffer = Buffer.alloc(Math.min(opened.size + 1, DATASET_LIMITS.maxFileBytes + 1))
    let used = 0
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null)
      if (!count) break
      used += count
    }
    if (used > DATASET_LIMITS.maxFileBytes || realpathSync(source) !== real) return null
    const after = statSync(real)
    const finalHandle = fstatSync(fd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || finalHandle.dev !== opened.dev || finalHandle.ino !== opened.ino || finalHandle.size !== opened.size || finalHandle.mtimeMs !== opened.mtimeMs || finalHandle.ctimeMs !== opened.ctimeMs || used !== opened.size) return null
    return { name: path.basename(real), bytes: buffer.subarray(0, used) }
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

export async function dispatch(tool: BoardsBridgeRequest, workspaceRoot?: string, stillAuthorized?: () => boolean): Promise<Record<string, unknown>> {
  if (tool.action === 'board_build_begin' || tool.action === 'board_build_status' || tool.action === 'board_build_preflight' || tool.action === 'board_build_commit' || tool.action === 'board_build_abort' || tool.action === 'board_refresh' || tool.action === 'board_meta_accounts') return { ok: false, error: 'session-required' }
  if (tool.action === 'boards_list') {
    return {
      ok: true,
      boards: listBoards().map((board) => ({ id: board.id, name: modelBoardName(board), widgetCount: board.widgets.length, locked: board.locked === true, updatedAt: board.updatedAt })),
      datasets: datasetsOverview()
    }
  }

  if (tool.action === 'board_get') {
    const board = findBoard(tool)
    if (!board) return { ok: false, error: 'board-not-found' }
    return { ok: true, board: boardSummary(board) }
  }

  if (tool.action === 'board_check') {
    const options = parseBoardGenerationOptions({ mode: tool.mode, required: tool.required, daily: tool.daily, granularity: tool.granularity, dimensions: tool.dimensions })
    if (!options) return { ok: false, error: 'invalid-check-options' }
    const board = findBoard(tool)
    if (!board) return { ok: false, error: 'board-not-found' }
    const { listQuerySpecs } = await import('./integrations/appsflyer/appsflyerDataset')
    const check = checkBoardGeneration(board, listDatasets(), options, listQuerySpecs(undefined, { persistMigration: false }))
    const passed = check.status === 'ready'
    return {
      ok: passed,
      passed,
      ...(!passed ? { error: check.status === 'incomplete' ? 'board-incomplete' : 'board-needs-attention' } : {}),
      boardId: board.id,
      updatedAt: board.updatedAt,
      ...check
    }
  }

  if (tool.action === 'board_create') {
    const boards = listBoards()
    if (boards.length >= BOARD_LIMITS.maxBoards) return { ok: false, error: 'too-many-boards' }
    const inferred = detectPreset(`${typeof tool.name === 'string' ? tool.name : ''} ${typeof tool.description === 'string' ? tool.description : ''}`)
    const template =
      typeof tool.template === 'string' && BOARD_TEMPLATES.includes(tool.template as BoardPresetId)
        ? (tool.template as BoardPresetId)
        : inferred === 'tiktok' || inferred === 'meta' ? inferred : 'blank'
    if (template === 'meta' && [tool.advertiserIds, tool.advertiserName, tool.advertiserNames].some(value => value != null)) {
      return { ok: false, error: 'invalid-platform-scope', message: 'advertiserIds / advertiserName / advertiserNames 仅用于 TikTok；Meta 账户范围请记录在来源模块及本次查询参数中。' }
    }
    const composed = composeBoard('', boardText, template)
    const name = boundedString(tool.name, BOARD_LIMITS.maxNameLength) ?? composed.name
    if (boards.some((board) => board.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'name-exists', existingBoards: boards.map(modelBoardName).slice(0, 50) }
    }
    const description = boundedString(tool.description, BOARD_LIMITS.maxDescriptionLength)
    const board: KanbanBoard = {
      ...composed,
      name,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(description ? { description } : {})
    }
    if (tool.style !== undefined) {
      const styled = mergeStyle(tool.style, board.style, CANVAS_STYLE_KEYS, validateBoardStyle)
      if (!styled.ok) return { ok: false, error: 'invalid-style' }
      if (styled.value) board.style = styled.value
      else delete board.style
    }
    if (tool.masterScope !== undefined) {
      if (!tool.masterScope || typeof tool.masterScope !== 'object' || Array.isArray(tool.masterScope) || Object.keys(tool.masterScope).some(key => !['range', 'metrics'].includes(key))) return { ok: false, error: 'invalid-master-scope' }
      const scope = validateMasterScope(tool.masterScope)
      if (!scope) return { ok: false, error: 'invalid-master-scope' }
      board.masterScope = scope
    }
    // A TikTok advertiser request binds a reading module to those advertisers
    // (empty string = every advertiser the connected grant covers) AND scopes
    // every dataset card to that advertiser (广告主 filter) so the board shows
    // ONE account's numbers and its currency stays uniform.
    if (tool.advertiserIds != null && typeof tool.advertiserIds !== 'string') return { ok: false, error: 'invalid-advertiser-ids', message: '请提供数字广告主 ID 字符串，多个 ID 用逗号分隔。' }
    const advertiserIdInput = typeof tool.advertiserIds === 'string' ? tool.advertiserIds.trim() : ''
    const advertiserName = boundedString(tool.advertiserName, 120)
    // Cross-account boards ("go photo 所有账户合一起"): accept an array or a
    // comma/、-separated string of advertiser NAMES; every dataset card then
    // OR-matches the set (single name keeps the scalar filter for compat).
    const advertiserNames: string[] = Array.isArray(tool.advertiserNames)
      ? tool.advertiserNames.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 20)
      : typeof tool.advertiserNames === 'string'
        ? tool.advertiserNames.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean).slice(0, 20)
        : []
    const names = advertiserNames.length > 0 ? advertiserNames : advertiserName ? [advertiserName] : []
    // Even a malformed name field signals that a narrower account scope was
    // requested; never turn it into an unscoped all-account reading.
    const nameScopeRequested = [tool.advertiserName, tool.advertiserNames].some((value) =>
      typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : value != null
    )
    const ids = parseTikTokAdvertiserIdList(advertiserIdInput)
    if (!ids || (advertiserIdInput && ids.length === 0)) return { ok: false, error: 'invalid-advertiser-ids', message: '请提供数字广告主 ID 字符串，多个 ID 用逗号分隔。' }
    const advertiserIds = ids.join(', ')
    if (nameScopeRequested && ids.length === 0) return { ok: false, error: 'advertiser-ids-required', message: '按名称筛选时请同时提供对应的数字广告主 ID，避免读取其他账户。' }
    const filterValues = ids?.length ? ids : names
    if (filterValues.length > 0) {
      const filterColumn = ids?.length ? '广告主ID' : '广告主'
      const scope = filterValues.length === 1
        ? { filterColumn, filterValue: filterValues[0] }
        : { filterColumn, filterValues }
      board.widgets = board.widgets.map((widget) =>
        widget.config && widget.config.source === 'dataset'
          ? { ...widget, config: { ...widget.config, ...scope } }
          : widget
      )
    }
    if (advertiserIds || template === 'tiktok') {
      const existing = board.widgets.find((widget) => widget.type === 'tt-reading')
      if (existing) {
        board.widgets = board.widgets.map((widget) => widget === existing
          ? { ...widget, config: { ...widget.config, advertiserIds } }
          : widget)
      } else {
        const size = WIDGET_DEFAULT_SIZES['tt-reading']
        const slot = findFreeSlot(board.widgets, size.w, size.h)
        board.widgets.push(createWidget('tt-reading', BOARD_TEXT['boards.widget.tt-reading'], slot, { advertiserIds, range: '7' }))
      }
    }
    if (board.masterScope) board.widgets = board.widgets.map(widget => applyMasterScope(widget, board.masterScope!))
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'save-failed' }
    // The TikTok template binds its KPIs/charts to the "TikTok 报表" dataset.
    // Tell the agent whether that data exists yet so it can pull the report
    // right away (the toolkit has touhou_tiktok_update) instead of leaving a
    // board full of waiting placeholders.
    const datasetReady = listDatasets().some((dataset) => dataset.name === 'TikTok 报表' && dataset.rows.length > 0)
    return {
      ok: true,
      board: persistedBoardSummary(board),
      ...(template === 'tiktok' ? { datasetReady } : {}),
      note: template === 'meta'
        ? '已创建 Meta 原生读数看板。请在 Meta 读数模块加载并选择已授权账户，刷新和总控日期切换会经 Main 只读 MCP 更新绑定的指标及每日趋势。不要将这些卡片改为 manual 固定快照，也不要添加整页 HTML 代替原生模块；缺失指标不补零。'
        :
        (ids.length > 0
          ? `已按 ${ids.length} 个广告主 ID 过滤数据卡并绑定 TT 读数模块；读数需要已连接的 TikTok 授权。`
          : template === 'tiktok'
            ? '已附 TT 读数模块（读取连接页所选账户；未选择时读取授权下的广告主）。'
            : '看板已创建。') +
        (ids.length > 1
          ? '注意：这些账户币种不同时，金额合计卡会显示 — 并标 MIX（不同币种不可相加），计数类指标正常合计。'
          : '') +
        (template !== 'tiktok' ? '' : datasetReady
          ? '这是可刷新看板；已有保存数据，仍需按本次所选日期和账户更新，不能将旧数据当成本次读数。'
          : '这是可刷新看板；用户要求业务数据看板已包含读取意图，按所选账户与日期调用 touhou_tiktok_update 获取数据，无需再次询问是否取数。只读广告平台，不修改广告。')
    }
  }

  // dataset_import — the agent's hand for the last mile: it can already fetch a
  // TikTok report CSV, and template widgets bind「TikTok 报表」BY NAME, so an
  // explicit-name import REPLACES that dataset and every bound widget fills.
  if (tool.action === 'dataset_import') {
    if (!workspaceRoot) return { ok: false, error: 'workspace-required' }
    const input = readWorkspaceDataset(tool.filePath, workspaceRoot)
    if (!input) return { ok: false, error: 'path-not-authorized' }
    const { importDatasetBuffer } = await import('./boardDatasets')
    if (stillAuthorized && !stillAuthorized()) return { ok: false, error: 'permission-denied' }
    const targetName = boundedString(tool.name, 200)
    const result = importDatasetBuffer(input.name, input.bytes, undefined, targetName ?? undefined)
    if (!result.ok) return { ...result, hint: 'CSV/XLSX，先由你自己下载/生成；路径需位于当前会话工作区。name 传「TikTok 报表」可直接点亮模板看板。' }
    return {
      ok: true,
      dataset: { name: result.dataset.name, rowCount: result.dataset.rows.length, columns: result.dataset.columns.map((c) => c.name) },
      truncated: result.truncated === true
    }
  }

  if (tool.action === 'af_dataset_pull') {
    const appId = boundedString(tool.appId, 200)
    const name = boundedString(tool.name, 60)
    const eventName = typeof tool.eventName === 'string' && tool.eventName.trim() ? tool.eventName.trim().slice(0, 200) : undefined
    if (!appId || !name) {
      return { ok: false, error: 'invalid-input', hint: 'appId 和 name 都是必填。name 是这组数据的短名（数据集叫 AF-{name}，卡片标题建议写「AF-{name}」）。' }
    }
    const basis = tool.basis === 'ltv' ? 'ltv' : 'activity'
    const days = tool.days === undefined ? 7 : Number(tool.days)
    if (!Number.isInteger(days) || days < 1 || days > 366) return { ok: false, error: 'invalid-window' }
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
    const end = new Date()
    end.setDate(end.getDate() - 1)
    const start = new Date(end)
    start.setDate(start.getDate() - (days - 1))
    let window = { start: iso(start), end: iso(end) }
    if (tool.startDate !== undefined || tool.endDate !== undefined) {
      if (!validDate(tool.startDate) || !validDate(tool.endDate) || tool.startDate > tool.endDate || Date.parse(tool.endDate) - Date.parse(tool.startDate) > 365 * 86_400_000) return { ok: false, error: 'invalid-window' }
      window = { start: tool.startDate, end: tool.endDate }
    }
    const metrics = Array.isArray(tool.metrics) && tool.metrics.length > 0 && tool.metrics.length <= 10 && tool.metrics.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 100)
      ? (tool.metrics as string[]) : ['Count', 'Unique users']
    if (tool.groupings !== undefined && (!Array.isArray(tool.groupings) || tool.groupings.length > 4 || tool.groupings.some(g => typeof g !== 'string' || !g.trim() || g.length > 100))) return { ok: false, error: 'invalid-groupings' }
    const isCustom = !!eventName && !isAppsFlyerBuiltInEvent(eventName)
    const groupings = tool.groupings === undefined
      ? (isCustom ? (tool.geo === true ? ['Campaign ID', 'Media source', 'Date'] : ['Campaign ID', 'Campaign', 'Media source', 'Date']) : (tool.geo === true ? ['Event name', 'Media source', 'Date'] : ['Event name', 'Media source', 'Date', 'Campaign ID']))
      : [...tool.groupings as string[]]
    if (tool.geo === true && !groupings.includes('Geo')) {
      if (groupings.length >= 4) return { ok: false, error: 'invalid-groupings', hint: 'Geo 也是一个维度；groupings 最多四项，请为它留一个位置。' }
      groupings.push('Geo')
    }
    const filters: Record<string, string[]> = {}
    if (tool.mediaSources === undefined) filters['Media source'] = ['tiktokglobal_int']
    else {
      if (!Array.isArray(tool.mediaSources) || tool.mediaSources.length > 32 || tool.mediaSources.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\x00-\x1f\x7f]/.test(value) || value.trim().toLowerCase() === 'all')) return { ok: false, error: 'invalid-media-sources' }
      const mediaSources = [...new Set((tool.mediaSources as string[]).map(value => value.trim()))]
      if (mediaSources.length) filters['Media source'] = mediaSources
    }
    if (tool.countries !== undefined) {
      if (!Array.isArray(tool.countries) || tool.countries.length === 0 || tool.countries.length > 20 || tool.countries.some(value => typeof value !== 'string' || !/^(?:[A-Za-z]{2,3}|all)$/i.test(value))) return { ok: false, error: 'invalid-countries' }
      const countries = [...new Set((tool.countries as string[]).map(value => value.toUpperCase()))]
      if (countries.includes('ALL')) {
        if (countries.length > 1) return { ok: false, error: 'invalid-countries' }
      } else filters.Geo = countries
    }
    const query: Record<string, unknown> = {
      app_ids: [appId],
      row_count: 300,
      metrics: metrics.map((metricName) => ({ metric_name: metricName, attribution_source: 'appsflyer', period: basis })),
      sort_by_metrics: [{ metric_name: metrics[0], order: 'desc' }],
      groupings,
      filters,
      in_app_event: isCustom ? [eventName!] : []
    }
    const { pullAppsFlyerDatasets, saveQuerySpec, listQuerySpecs } = await import('./integrations/appsflyer/appsflyerDataset')
    if (stillAuthorized && !stillAuthorized()) return { ok: false, error: 'permission-denied' }
    // Legacy IDs were truncated and could alias different applications/names.
    // Match the complete recipe identity before preserving an existing binding;
    // new IDs hash a structured tuple so long names and separators stay distinct.
    const previousSpec = listQuerySpecs().find(spec => Array.isArray(spec.query.app_ids) && spec.query.app_ids[0] === appId && spec.name === name)
    const specId = previousSpec?.id ?? `afq-${createHash('sha256').update(JSON.stringify([appId, name])).digest('hex')}`
    const previousDataset = previousSpec?.datasetId ? listDatasets().find(dataset => dataset.id === previousSpec.datasetId) : undefined
    const datasetName = previousDataset?.name ?? previousSpec?.datasetName ?? `AF-${name}`
    // Record the spec BEFORE the pull (minus dates): even a transient failure
    // arms the master refresh. Replacing its query must preserve the bound
    // dataset identity, including a name changed since the previous pull.
    try {
      saveQuerySpec({ ...previousSpec, id: specId, name, datasetName, query })
    } catch (error) {
      if (error instanceof Error && error.message === 'query-limit') return {
        ok: false,
        error: 'query-limit',
        hint: 'AppsFlyer 已有 20 组可刷新查询；请复用已有查询，或先清理不再使用的查询。现有数据与看板绑定已保留。'
      }
      throw error
    }
    const result = await pullAppsFlyerDatasets({ window, specIds: [specId] })
    if (!result.ok && !result.results.some((entry) => entry.ok)) {
      const failedEntry = result.results[0]
      const hints: Record<string, string> = {
        'not-connected': 'AppsFlyer 未连接或授权未验证，请先在连接页完成 AppsFlyer 授权。',
        'no-specs': 'pull 参数为空。'
      }
      return {
        ok: false,
        error: failedEntry?.error ?? result.error ?? 'pull-failed',
        ...(hints[result.error ?? ''] ? { hint: hints[result.error ?? ''] } : {})
      }
    }
    // The written dataset's real column names (localized, metadata columns
    // included) — the agent binds cards by these exact names.
    const { listDatasetsStrict } = await import('./boardDatasets')
    const completed = result.results.find(entry => entry.ok && entry.datasetId)
    const dataset = completed ? listDatasetsStrict().find(candidate => candidate.id === completed.datasetId) : undefined
    if (!dataset) return { ok: false, error: 'dataset-not-ready', results: result.results }
    const columns = dataset.columns.map((c) => c.name)
    return {
      ok: true,
      spec: { id: specId },
      window,
      dataset: { id: dataset.id, name: dataset.name, rowCount: dataset.rows.length, columns },
      binding: {
        hint: `把数字卡/图表绑定本数据集：source="dataset"，datasetId="${dataset.id}"，metric 用 dataset.columns 的列名；事件次数可求和，独立用户使用按完整日期范围查询的专用总量，不跨日相加。可加 filterColumn/filterValue。标题用简短业务名，来源信息放详情。`,
        columns
      },
      results: result.results
    }
  }

  const board = findBoard(tool)
  if (!board) return { ok: false, error: 'board-not-found' }
  if (board.locked === true) return { ok: false, error: 'board-locked' }

  if (tool.action === 'board_customize') {
    if (tool.version !== 1 || (tool.preview !== undefined && typeof tool.preview !== 'boolean') || !Number.isSafeInteger(tool.expectedUpdatedAt)) return { ok: false, error: 'invalid-customization' }
    if (tool.expectedUpdatedAt !== board.updatedAt) return { ok: false, error: 'conflict', updatedAt: board.updatedAt }
    if (tool.widgets !== undefined && (!Array.isArray(tool.widgets) || tool.widgets.length > BOARD_LIMITS.maxWidgets)) return { ok: false, error: 'invalid-customization' }
    if (tool.style === undefined && tool.masterScope === undefined && (!Array.isArray(tool.widgets) || tool.widgets.length === 0)) return { ok: false, error: 'invalid-customization' }
    const next: KanbanBoard = structuredClone(board)
    if (tool.style !== undefined) {
      const styled = mergeStyle<BoardStyle>(tool.style, next.style, CANVAS_STYLE_KEYS, validateBoardStyle)
      if (!styled.ok) return { ok: false, error: 'invalid-style' }
      if (styled.value) next.style = styled.value
      else delete next.style
    }
    if (tool.masterScope !== undefined) {
      if (!tool.masterScope || typeof tool.masterScope !== 'object' || Array.isArray(tool.masterScope) || Object.keys(tool.masterScope).some(key => !['range', 'metrics'].includes(key))) return { ok: false, error: 'invalid-master-scope' }
      const scope = validateMasterScope(tool.masterScope)
      if (!scope) return { ok: false, error: 'invalid-master-scope' }
      next.masterScope = scope
      next.widgets = next.widgets.map(widget => applyMasterScope(widget, scope))
    }
    const patchedIds = new Set<string>()
    const movedIds = new Set<string>()
    for (const input of (tool.widgets ?? []) as unknown[]) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid-customization' }
      const patch = input as Record<string, unknown>
      if (Object.keys(patch).some(key => !['widgetId', 'title', 'layout', 'style', 'dateScope'].includes(key))) return { ok: false, error: 'invalid-customization' }
      const widgetId = boundedString(patch.widgetId, BOARD_LIMITS.maxIdLength)
      const target = next.widgets.find(widget => widget.id === widgetId)
      if (!target || patchedIds.has(target.id)) return { ok: false, error: target ? 'duplicate-widget' : 'widget-not-found' }
      patchedIds.add(target.id)
      if (patch.dateScope !== undefined) {
        const scope = validateWidgetDateScope(patch.dateScope)
        if (!scope) return { ok: false, error: 'invalid-date-scope' }
        target.dateScope = scope
      }
      if (patch.title !== undefined) {
        if (typeof patch.title !== 'string' || patch.title.length > BOARD_LIMITS.maxWidgetTitleLength || /[\x00-\x1f\x7f]/.test(patch.title)) return { ok: false, error: 'invalid-title' }
        target.title = patch.title.trim()
      }
      if (patch.layout !== undefined) {
        const layout = preciseLayout(patch.layout)
        if (!layout) return { ok: false, error: 'invalid-layout' }
        target.layout = layout
        movedIds.add(target.id)
      }
      if (patch.style !== undefined) {
        const styled = mergeStyle<BoardWidgetStyle>(patch.style, target.style, WIDGET_STYLE_KEYS, validateBoardWidgetStyle)
        if (!styled.ok) return { ok: false, error: 'invalid-style' }
        if (styled.value) target.style = styled.value
        else delete target.style
      }
    }
    if (movedWidgetsOverlap(next.widgets, movedIds)) return { ok: false, error: 'overlapping-layout' }
    if (!validateBoard(next, true)) return { ok: false, error: 'invalid-customization' }
    const changes: Array<Record<string, unknown>> = []
    if (!isDeepStrictEqual(board.style, next.style)) changes.push({ target: 'board', before: board.style ?? null, after: next.style ?? null })
    if (!isDeepStrictEqual(board.masterScope, next.masterScope)) changes.push({ target: 'masterScope', before: board.masterScope ?? null, after: next.masterScope ?? null })
    for (const widget of next.widgets) {
      const previous = board.widgets.find(item => item.id === widget.id)!
      const before = { title: previous.title, layout: previous.layout, style: previous.style ?? null, dateScope: previous.dateScope ?? null }
      const after = { title: widget.title, layout: widget.layout, style: widget.style ?? null, dateScope: widget.dateScope ?? null }
      if (!isDeepStrictEqual(before, after)) changes.push({ widgetId: widget.id, before, after })
      if (!isDeepStrictEqual(previous.config, widget.config)) changes.push({ widgetId: widget.id, target: 'scope', before: { range: previous.config.range ?? null, metrics: previous.config.metrics ?? null, independent: previous.config.independent === true }, after: { range: widget.config.range ?? null, metrics: widget.config.metrics ?? null, independent: widget.config.independent === true } })
    }
    if (tool.preview !== false) return { ok: true, preview: true, expectedUpdatedAt: board.updatedAt, changes, previewBoard: boardSummary(next) }
    if (changes.length === 0) return { ok: true, applied: false, board: boardSummary(board), changes }
    if (stillAuthorized && !stillAuthorized()) return { ok: false, error: 'permission-denied' }
    next.updatedAt = Math.max(Date.now(), board.updatedAt + 1)
    const result = saveBoard(next, undefined, board.updatedAt)
    if (!result.ok) return { ok: false, error: result.error }
    const saved = listBoards().find(item => item.id === board.id)
    return { ok: true, applied: true, board: boardSummary(saved ?? next), changes }
  }

  if (tool.action === 'board_add_widget') {
    if (board.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'too-many-widgets' }
    const type = typeof tool.type === 'string' && WIDGET_TYPES.includes(tool.type as WidgetType) ? (tool.type as WidgetType) : null
    if (!type) return { ok: false, error: 'unsupported-widget-type', supported: WIDGET_TYPES.filter((item) => item !== 'reading-snapshot') }
    // A model cannot fabricate an allegedly saved reading by supplying a
    // well-shaped snapshot. Only the local reading-save flow creates these.
    if (type === 'reading-snapshot') return { ok: false, error: 'snapshot-requires-reading' }
    const title = boundedString(tool.title, BOARD_LIMITS.maxWidgetTitleLength) ?? WIDGET_TITLE_ZH[type]
    let size = type === 'file' ? { w: 12, h: 12 } : WIDGET_DEFAULT_SIZES[type]
    let requestedLayout: BoardWidgetLayout | null = null
    if (tool.layout !== undefined) {
      const layout = tool.layout as Record<string, unknown> | null
      if (!layout || typeof layout !== 'object' || Array.isArray(layout) || Object.keys(layout).some(key => !['x', 'y', 'w', 'h'].includes(key)) || !Number.isInteger(layout.w) || !Number.isInteger(layout.h) || (layout.w as number) < 1 || (layout.w as number) > 12 || (layout.h as number) < 1 || (layout.h as number) > 20) return { ok: false, error: 'invalid-layout' }
      size = { w: layout.w as number, h: layout.h as number }
      if (layout.x !== undefined || layout.y !== undefined) {
        requestedLayout = preciseLayout(layout)
        if (!requestedLayout) return { ok: false, error: 'invalid-layout' }
        if (board.widgets.some(widget => intersects(widget.layout, requestedLayout!))) return { ok: false, error: 'overlapping-layout' }
      }
    }
    const slot = findFreeSlot(board.widgets, size.w, size.h)
    let config =
      tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config)
        ? (tool.config as Record<string, unknown>)
        : undefined
    if (type === 'reading-module') {
      const source = tool.source as Record<string, unknown> | null
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['boardId', 'widgetId'].includes(key)) || typeof source.boardId !== 'string' || typeof source.widgetId !== 'string' || !config || Object.keys(config).some(key => key !== 'module')) return { ok: false, error: 'snapshot-requires-reading' }
      const sourceWidget = listBoards().find(entry => entry.id === source.boardId)?.widgets.find(entry => entry.id === source.widgetId && (entry.type === 'reading-snapshot' || entry.type === 'reading-module'))
      const snapshot = validateReadingSnapshot(sourceWidget?.config.snapshot)
      if (!snapshot) return { ok: false, error: 'snapshot-requires-reading' }
      config = { snapshot: structuredClone(snapshot), module: config.module }
    }
    const widget = createWidget(type, title, slot, config)
    if (bindsInternalDataset(widget)) return { ok: false, error: 'internal-dataset-binding' }
    if (tool.dateScope !== undefined) {
      const scope = validateWidgetDateScope(tool.dateScope)
      if (!scope) return { ok: false, error: 'invalid-date-scope' }
      widget.dateScope = scope
    }
    widget.layout = requestedLayout ?? { ...slot, ...size }
    if (tool.style !== undefined) {
      const styled = mergeStyle<BoardWidgetStyle>(tool.style, widget.style, WIDGET_STYLE_KEYS, validateBoardWidgetStyle)
      if (!styled.ok) return { ok: false, error: 'invalid-style' }
      if (styled.value) widget.style = styled.value
      else delete widget.style
    }
    board.widgets = [...board.widgets, board.masterScope && widget.config.independent !== true ? applyMasterScope(widget, board.masterScope) : widget]
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'invalid-widget-config' }
    return { ok: true, board: persistedBoardSummary(board), createdWidgetId: widget.id }
  }

  if (tool.action === 'board_remove_widget') {
    const widgetId = boundedString(tool.widgetId, BOARD_LIMITS.maxIdLength)
    if (!widgetId || !board.widgets.some((widget) => widget.id === widgetId)) {
      return { ok: false, error: 'widget-not-found' }
    }
    board.widgets = board.widgets.filter((widget) => widget.id !== widgetId)
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'save-failed' }
    const cleanup = boardBuildRoot() ? { ok: true } : pruneHtmlBoardsForBoard({ boardId: board.id, retainedWidgetIds: board.widgets.filter(widget => widget.type === 'reading-snapshot' || widget.type === 'reading-module').map(widget => widget.id) })
    if (!cleanup.ok) return { ok: false, error: 'html-cleanup-failed', message: '组件已删除，但本地 HTML 副本清理失败；请在看板中重试清理。' }
    return { ok: true, board: persistedBoardSummary(board) }
  }

  if (tool.action === 'board_update_widget') {
    const widgetId = boundedString(tool.widgetId, BOARD_LIMITS.maxIdLength)
    const target = widgetId ? board.widgets.find((widget) => widget.id === widgetId) : undefined
    if (!target) return { ok: false, error: 'widget-not-found' }
    const title = boundedString(tool.title, BOARD_LIMITS.maxWidgetTitleLength)
    let config = target.config
    if (tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config)) {
      if (target.type === 'reading-module' || (target.type === 'reading-snapshot' && Object.hasOwn(tool.config, 'snapshot'))) return { ok: false, error: 'snapshot-requires-reading' }
      // Shallow merge: the agent patches fields, saveBoard's strict validator
      // whitelists the result atomically.
      config = { ...target.config, ...(tool.config as Record<string, unknown>) }
    }
    let layout = target.layout
    if (tool.layout !== undefined) {
      const parsed = preciseLayout(tool.layout)
      if (!parsed) return { ok: false, error: 'invalid-layout' }
      if (board.widgets.some(widget => widget.id !== target.id && intersects(widget.layout, parsed))) return { ok: false, error: 'overlapping-layout' }
      layout = parsed
    }
    let style = target.style
    let dateScope = target.dateScope
    if (tool.dateScope !== undefined) {
      const parsed = validateWidgetDateScope(tool.dateScope)
      if (!parsed) return { ok: false, error: 'invalid-date-scope' }
      dateScope = parsed
    }
    if (tool.style !== undefined) {
      const styled = mergeStyle<BoardWidgetStyle>(tool.style, target.style, WIDGET_STYLE_KEYS, validateBoardWidgetStyle)
      if (!styled.ok) return { ok: false, error: 'invalid-style' }
      style = styled.value
    }
    board.widgets = board.widgets.map((widget) =>
      widget.id === widgetId ? ({ ...widget, ...(title ? { title } : {}), config, layout, ...(style ? { style } : {}), ...(dateScope ? { dateScope } : {}) } as BoardWidget) : widget
    )
    if (bindsInternalDataset(board.widgets.find(widget => widget.id === widgetId)!)) return { ok: false, error: 'internal-dataset-binding' }
    if (tool.style === null) delete board.widgets.find(widget => widget.id === widgetId)!.style
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'invalid-widget-config' }
    return { ok: true, board: persistedBoardSummary(board) }
  }

  // board_rename
  const newName = boundedString(tool.newName, BOARD_LIMITS.maxNameLength)
  if (!newName) return { ok: false, error: 'invalid-name' }
  if (listBoards().some((other) => other.id !== board.id && other.name.toLowerCase() === newName.toLowerCase())) {
    return { ok: false, error: 'name-exists' }
  }
  const result = saveBoard({ ...board, name: newName, updatedAt: Date.now() })
  if (!result.ok) return { ok: false, error: 'save-failed' }
  return { ok: true, board: persistedBoardSummary({ ...board, name: newName }) }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 256_000))
}
