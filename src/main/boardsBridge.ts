import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { DATASET_LIMITS } from '../shared/datasets'
import type { PermissionMode } from '../shared/types'
import { parseTikTokAdvertiserIdList } from '../shared/tiktokReport'
import { serializeBoundedJson } from '../shared/boundedJson'
import { validateReadingSnapshot } from '../shared/readingSnapshot'
import { getBoardHighlightEvidence } from './boardHighlights'
import { listBoards, peekBoardsForConfirmation, saveBoard } from './boards'
import { pruneHtmlBoardsForBoard } from './htmlBoards'
import { listDatasets } from './boardDatasets'
import {
  BOARD_LIMITS,
  WIDGET_DEFAULT_SIZES,
  WIDGET_TYPES,
  composeBoard,
  createWidget,
  detectPreset,
  findFreeSlot,
  type BoardPresetId,
  type BoardText
} from '../shared/boards'
import type { BoardWidget, KanbanBoard, WidgetType } from '../shared/types'

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
  todo: '待办清单',
  link: '链接',
  file: '文件'
}

export type BoardsBridgeRequest =
  | { action: 'boards_list' }
  | { action: 'board_get'; boardId?: unknown; name?: unknown }
  | {
      action: 'board_create'
      name?: unknown
      template?: unknown
      description?: unknown
      advertiserIds?: unknown
      advertiserName?: unknown
      advertiserNames?: unknown
    }
  | { action: 'board_add_widget'; boardId?: unknown; name?: unknown; type?: unknown; title?: unknown; config?: unknown; source?: unknown; layout?: unknown }
  | { action: 'board_remove_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown }
  | { action: 'board_update_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown; title?: unknown; config?: unknown }
  | { action: 'board_rename'; boardId?: unknown; name?: unknown; newName?: unknown }
  | { action: 'dataset_import'; filePath?: unknown; name?: unknown }
  | { action: 'af_dataset_pull'; name?: unknown; appId?: unknown; eventName?: unknown; days?: unknown; basis?: unknown; metrics?: unknown; groupings?: unknown; geo?: unknown }

function boundedString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean.length > 0 && clean.length <= max ? clean : null
}

export function parseBoardsBridgeRequest(raw: unknown): BoardsBridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  switch (value.action) {
    case 'boards_list':
      return { action: 'boards_list' }
    case 'board_get':
      return { action: 'board_get', boardId: value.boardId, name: value.name }
    case 'board_create':
      return {
        action: 'board_create',
        name: value.name,
        template: value.template,
        description: value.description,
        advertiserIds: value.advertiserIds,
        advertiserName: value.advertiserName,
        advertiserNames: value.advertiserNames
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
        layout: value.layout
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
        config: value.config
      }
    case 'board_rename':
      return { action: 'board_rename', boardId: value.boardId, name: value.name, newName: value.newName }
    case 'dataset_import':
      return { action: 'dataset_import', filePath: value.filePath, name: value.name }
    case 'af_dataset_pull':
      return { action: 'af_dataset_pull', name: value.name, appId: value.appId, eventName: value.eventName, days: value.days, basis: value.basis, metrics: value.metrics, groupings: value.groupings, geo: value.geo }
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
    widgets: board.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      title: widget.title,
      layout: { ...widget.layout },
      config: widget.type === 'reading-snapshot' ? readingSnapshotSummary(board, widget.id, widget.config) : widget.type === 'reading-module' ? { accountCount: validateReadingSnapshot(widget.config.snapshot)?.accounts.length ?? 0, module: widget.config.module } : widget.config
    }))
  }
}

/** Model-facing board reads use a bounded snapshot projection and omit provider errors. */
function readingSnapshotSummary(board: KanbanBoard, widgetId: string, config: Record<string, unknown>): Record<string, unknown> {
  const snapshot = validateReadingSnapshot(config.snapshot)
  if (!snapshot) return { unavailable: true }
  const result = getBoardHighlightEvidence({ boardId: board.id, widgetId }, { list: () => [board] })
  return result.ok ? { accountCount: snapshot.accounts.length, evidence: result.evidence } : { unavailable: true }
}

function datasetsOverview(): Array<Record<string, unknown>> {
  return listDatasets().map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    rowCount: dataset.rows.length,
    columns: dataset.columns.map((column) => ({ name: column.name, type: column.type }))
  }))
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
  if (request.action === 'board_add_widget' && typeof request.boardId === 'string' && request.boardId) {
    try {
      const board = readBoards().find(item => item.id === request.boardId)
      if (board) details.unshift(`看板: ${board.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240)}`)
    } catch { /* Never guess a name when the board store cannot be read. */ }
  }
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
  const write = tool.action !== 'boards_list' && tool.action !== 'board_get'
  if (write && (access.remoteReadonly || !['full', 'no-bash', 'ask'].includes(access.mode))) return { ok: false, error: 'permission-denied' }
  if (write && access.mode === 'ask') {
    const confirm = deps?.confirm ?? (async (request: BoardsBridgeRequest) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!win || win.isDestroyed()) return false
      const labels: Record<string, string> = {
        board_create: '新建看板', board_rename: '重命名看板', board_add_widget: '添加组件',
        board_update_widget: '修改组件', board_remove_widget: '移除组件', dataset_import: '导入数据集'
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
  return dispatch(tool, access.cwd, write ? stillAuthorized : undefined)
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
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'save-failed' }
    // The TikTok template binds its KPIs/charts to the "TikTok 报表" dataset.
    // Tell the agent whether that data exists yet so it can pull the report
    // right away (the toolkit has touhou_tiktok_update) instead of leaving a
    // board full of waiting placeholders.
    const datasetReady = listDatasets().some((dataset) => dataset.name === 'TikTok 报表' && dataset.rows.length > 0)
    return {
      ok: true,
      board: boardSummary({ ...board }),
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
          ? '数据集「TikTok 报表」已有数据。'
          : '数据集「TikTok 报表」还没有数据；仅在用户明确要求读取时调用 touhou_tiktok_update，失败后如实告知，不得绕路读取。')
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
    const days = Math.min(Math.max(Number(tool.days) || 7, 1), 366)
    const metrics = Array.isArray(tool.metrics) && tool.metrics.length > 0 && tool.metrics.length <= 10 && tool.metrics.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 100)
      ? (tool.metrics as string[]) : ['Count', 'Unique users']
    const groupings = Array.isArray(tool.groupings) && tool.groupings.length > 0 && tool.groupings.length <= 4 && tool.groupings.every((g) => typeof g === 'string' && g.length > 0 && g.length <= 100)
      ? (tool.groupings as string[]) : (eventName ? ['Campaign ID', 'Campaign', 'Media source', 'Date'] : ['Event name', 'Media source', 'Date', 'Campaign ID'])
    const isCustom = !!eventName && eventName.toLowerCase().startsWith('af_')
    const filters: Record<string, string[]> = { 'Media source': ['tiktokglobal_int'] }
    if (tool.geo === true) filters.Geo = ['all']
    const query: Record<string, unknown> = {
      app_ids: [appId],
      row_count: 100,
      metrics: metrics.map((metricName) => ({ metric_name: metricName, attribution_source: 'appsflyer', period: basis })),
      sort_by_metrics: [{ metric_name: metrics[0], order: 'desc' }],
      groupings,
      filters,
      in_app_event: isCustom ? [eventName!] : []
    }
    const specId = `afq-${appId}-${name}`.slice(0, 80)
    const datasetName = `AF-${name}`
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - (days - 1))
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const { pullAppsFlyerDatasets, saveQuerySpec } = await import('./integrations/appsflyer/appsflyerDataset')
    if (stillAuthorized && !stillAuthorized()) return { ok: false, error: 'permission-denied' }
    // Record the spec BEFORE the pull (minus dates): even a transient failure
    // arms the master refresh — the pin is the query, not the last result.
    saveQuerySpec({ id: specId, name, datasetName, query })
    const result = await pullAppsFlyerDatasets({ window: { start: iso(start), end: iso(end) }, specIds: [specId] })
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
    const dataset = listDatasetsStrict().find((d) => d.name === datasetName)
    const columns = dataset ? dataset.columns.map((c) => c.name) : []
    return {
      ok: true,
      dataset: { name: datasetName, rowCount: dataset?.rows.length ?? 0, columns },
      binding: {
        hint: `把数字卡/图表绑到本数据集即成为活卡（总控刷新会自动重拉本数据集）：source="dataset"，datasetId="${datasetName}"，metric 用数据列名（如「事件次数」「独立用户」「安装量」），op="sum"；可加 filterColumn/filterValue（如 事件/活动ID/地区）筛选。卡片标题（title）写「AF-${name}」这种形式；metric 列名以 dataset.columns 为准。`,
        columns
      },
      results: result.results
    }
  }

  const board = findBoard(tool)
  if (!board) return { ok: false, error: 'board-not-found' }
  if (board.locked === true) return { ok: false, error: 'board-locked' }

  if (tool.action === 'board_add_widget') {
    if (board.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'too-many-widgets' }
    const type = typeof tool.type === 'string' && WIDGET_TYPES.includes(tool.type as WidgetType) ? (tool.type as WidgetType) : null
    if (!type) return { ok: false, error: 'unsupported-widget-type', supported: WIDGET_TYPES.filter((item) => item !== 'reading-snapshot') }
    // A model cannot fabricate an allegedly saved reading by supplying a
    // well-shaped snapshot. Only the local reading-save flow creates these.
    if (type === 'reading-snapshot') return { ok: false, error: 'snapshot-requires-reading' }
    const title = boundedString(tool.title, BOARD_LIMITS.maxWidgetTitleLength) ?? WIDGET_TITLE_ZH[type]
    let size = type === 'file' ? { w: 12, h: 12 } : WIDGET_DEFAULT_SIZES[type]
    if (tool.layout !== undefined) {
      const layout = tool.layout as Record<string, unknown> | null
      if (!layout || typeof layout !== 'object' || Array.isArray(layout) || Object.keys(layout).some(key => !['w', 'h'].includes(key)) || !Number.isInteger(layout.w) || !Number.isInteger(layout.h) || (layout.w as number) < 1 || (layout.w as number) > 12 || (layout.h as number) < 1 || (layout.h as number) > 20) return { ok: false, error: 'invalid-layout' }
      size = { w: layout.w as number, h: layout.h as number }
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
    widget.layout = { ...slot, ...size }
    board.widgets = [...board.widgets, widget]
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'invalid-widget-config' }
    return { ok: true, board: boardSummary(board), createdWidgetId: widget.id }
  }

  if (tool.action === 'board_remove_widget') {
    const widgetId = boundedString(tool.widgetId, BOARD_LIMITS.maxIdLength)
    if (!widgetId || !board.widgets.some((widget) => widget.id === widgetId)) {
      return { ok: false, error: 'widget-not-found' }
    }
    board.widgets = board.widgets.filter((widget) => widget.id !== widgetId)
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'save-failed' }
    const cleanup = pruneHtmlBoardsForBoard({ boardId: board.id, retainedWidgetIds: board.widgets.filter(widget => widget.type === 'reading-snapshot' || widget.type === 'reading-module').map(widget => widget.id) })
    if (!cleanup.ok) return { ok: false, error: 'html-cleanup-failed', message: '组件已删除，但本地 HTML 副本清理失败；请在看板中重试清理。' }
    return { ok: true, board: boardSummary(board) }
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
    board.widgets = board.widgets.map((widget) =>
      widget.id === widgetId ? ({ ...widget, ...(title ? { title } : {}), config } as BoardWidget) : widget
    )
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'invalid-widget-config' }
    return { ok: true, board: boardSummary(board) }
  }

  // board_rename
  const newName = boundedString(tool.newName, BOARD_LIMITS.maxNameLength)
  if (!newName) return { ok: false, error: 'invalid-name' }
  if (listBoards().some((other) => other.id !== board.id && other.name.toLowerCase() === newName.toLowerCase())) {
    return { ok: false, error: 'name-exists' }
  }
  const result = saveBoard({ ...board, name: newName, updatedAt: Date.now() })
  if (!result.ok) return { ok: false, error: 'save-failed' }
  return { ok: true, board: boardSummary({ ...board, name: newName }) }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 256_000))
}
