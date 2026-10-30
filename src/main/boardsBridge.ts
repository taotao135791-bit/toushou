import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { serializeBoundedJson } from '../shared/boundedJson'
import { listBoards, saveBoard } from './boards'
import { listDatasets } from './boardDatasets'
import {
  BOARD_LIMITS,
  WIDGET_DEFAULT_SIZES,
  WIDGET_TYPES,
  composeBoard,
  createWidget,
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

const MAX_BODY_BYTES = 16 * 1024
export const BOARDS_TOOLS_ENV_KEY = 'TOUSHOU_BOARDS'

/** Main-side zh display text for the shared board presets (Main cannot import
 *  the renderer i18n; connection labels already follow this zh-first rule). */
const BOARD_TEXT: Record<string, string> = {
  'boards.widget.clock': '时钟',
  'boards.widget.note': '便签',
  'boards.widget.todo': '待办清单',
  'boards.widget.fb-reading': 'FB 读数',
  'boards.widget.fb-reading-summary': 'FB 读数汇总',
  'boards.widget.fb-report-reading': 'FB 报表读数',
  'boards.widget.tt-reading': 'TT 读数',
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
  'boards.preset.fbDaily2': 'Facebook 投放日报（2）',
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
  'fb-daily',
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
  | { action: 'board_add_widget'; boardId?: unknown; name?: unknown; type?: unknown; title?: unknown; config?: unknown }
  | { action: 'board_remove_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown }
  | { action: 'board_update_widget'; boardId?: unknown; name?: unknown; widgetId?: unknown; title?: unknown; config?: unknown }
  | { action: 'board_rename'; boardId?: unknown; name?: unknown; newName?: unknown }
  | { action: 'dataset_import'; filePath?: unknown; name?: unknown }

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
        config: value.config
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
  // Session binding: the tool only works inside a live TouShou session.
  const { getSession } = await import('./omp')
  if (!getSession(sessionId)) return json(response, 200, { ok: false, error: 'no-session' })
  return json(response, 200, await dispatch(tool))
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

function boardSummary(board: KanbanBoard): Record<string, unknown> {
  return {
    id: board.id,
    name: board.name,
    locked: board.locked === true,
    widgetCount: board.widgets.length,
    updatedAt: board.updatedAt,
    widgets: board.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      title: widget.title,
      config: widget.config
    }))
  }
}

function datasetsOverview(): Array<Record<string, unknown>> {
  return listDatasets().map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    rowCount: dataset.rows.length,
    columns: dataset.columns.map((column) => ({ name: column.name, type: column.type }))
  }))
}

export async function dispatch(tool: BoardsBridgeRequest): Promise<Record<string, unknown>> {
  if (tool.action === 'boards_list') {
    return {
      ok: true,
      boards: listBoards().map((board) => ({ id: board.id, name: board.name, widgetCount: board.widgets.length, locked: board.locked === true, updatedAt: board.updatedAt })),
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
    const template =
      typeof tool.template === 'string' && BOARD_TEMPLATES.includes(tool.template as BoardPresetId)
        ? (tool.template as BoardPresetId)
        : 'tiktok'
    const composed = composeBoard('', boardText, template)
    const name = boundedString(tool.name, BOARD_LIMITS.maxNameLength) ?? composed.name
    if (boards.some((board) => board.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'name-exists', existingBoards: boards.map((board) => board.name).slice(0, 50) }
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
    const advertiserIds = typeof tool.advertiserIds === 'string' ? tool.advertiserIds.trim() : ''
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
    if (names.length > 0) {
      const scope =
        names.length === 1
          ? { filterColumn: '广告主', filterValue: names[0] }
          : { filterColumn: '广告主', filterValues: names }
      board.widgets = board.widgets.map((widget) =>
        widget.config && widget.config.source === 'dataset'
          ? { ...widget, config: { ...widget.config, ...scope } }
          : widget
      )
    }
    if (advertiserIds || template === 'tiktok') {
      const size = WIDGET_DEFAULT_SIZES['tt-reading']
      const slot = findFreeSlot(board.widgets, size.w, size.h)
      board.widgets.push(
        createWidget('tt-reading', BOARD_TEXT['boards.widget.tt-reading'], slot, {
          advertiserIds: /^[0-9,，;；\s]*$/.test(advertiserIds) ? advertiserIds : '',
          range: '7'
        })
      )
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
      datasetReady,
      note:
        (names.length > 1
          ? `已按 ${names.length} 个广告主合并过滤全部数据卡（${names.join('、')}）；`
          : advertiserIds
            ? '已绑定指定广告主的 TT 读数模块；读数需要已连接的 TikTok 授权。'
            : '已附 TT 读数模块（读取当前授权下的全部广告主）。') +
        (names.length > 1
          ? '注意：这些账户币种不同时，金额合计卡会显示 — 并标 MIX（不同币种不可相加），计数类指标正常合计。'
          : '') +
        (datasetReady
          ? '数据集「TikTok 报表」已有数据。'
          : '数据集「TikTok 报表」还没有数据：调用 touhou_tiktok_update（走 TikTok MCP 连接）拉取即可自动填充；它失败就如实把错误转述给用户并停下，禁止 CSV/文件/computer use 绕路。')
    }
  }

  // dataset_import — the agent's hand for the last mile: it can already fetch a
  // TikTok report CSV, and template widgets bind「TikTok 报表」BY NAME, so an
  // explicit-name import REPLACES that dataset and every bound widget fills.
  if (tool.action === 'dataset_import') {
    const { importDataset } = await import('./boardDatasets')
    const targetName = boundedString(tool.name, 200)
    const result = importDataset(tool.filePath, undefined, targetName ?? undefined)
    if (!result.ok) return { ...result, hint: 'CSV/XLSX，先由你自己下载/生成；路径写绝对路径。name 传「TikTok 报表」可直接点亮模板看板。' }
    return {
      ok: true,
      dataset: { name: result.dataset.name, rowCount: result.dataset.rows.length, columns: result.dataset.columns.map((c) => c.name) },
      truncated: result.truncated === true
    }
  }

  const board = findBoard(tool)
  if (!board) return { ok: false, error: 'board-not-found' }
  if (board.locked === true) return { ok: false, error: 'board-locked' }

  if (tool.action === 'board_add_widget') {
    if (board.widgets.length >= BOARD_LIMITS.maxWidgets) return { ok: false, error: 'too-many-widgets' }
    const type = typeof tool.type === 'string' && WIDGET_TYPES.includes(tool.type as WidgetType) ? (tool.type as WidgetType) : null
    if (!type) return { ok: false, error: 'unsupported-widget-type', supported: WIDGET_TYPES }
    const title = boundedString(tool.title, BOARD_LIMITS.maxWidgetTitleLength) ?? WIDGET_TITLE_ZH[type]
    const size = WIDGET_DEFAULT_SIZES[type]
    const slot = findFreeSlot(board.widgets, size.w, size.h)
    const config =
      tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config)
        ? (tool.config as Record<string, unknown>)
        : undefined
    board.widgets = [...board.widgets, createWidget(type, title, slot, config)]
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'invalid-widget-config' }
    return { ok: true, board: boardSummary(board) }
  }

  if (tool.action === 'board_remove_widget') {
    const widgetId = boundedString(tool.widgetId, BOARD_LIMITS.maxIdLength)
    if (!widgetId || !board.widgets.some((widget) => widget.id === widgetId)) {
      return { ok: false, error: 'widget-not-found' }
    }
    board.widgets = board.widgets.filter((widget) => widget.id !== widgetId)
    const result = saveBoard(board)
    if (!result.ok) return { ok: false, error: 'save-failed' }
    return { ok: true, board: boardSummary(board) }
  }

  if (tool.action === 'board_update_widget') {
    const widgetId = boundedString(tool.widgetId, BOARD_LIMITS.maxIdLength)
    const target = widgetId ? board.widgets.find((widget) => widget.id === widgetId) : undefined
    if (!target) return { ok: false, error: 'widget-not-found' }
    const title = boundedString(tool.title, BOARD_LIMITS.maxWidgetTitleLength)
    let config = target.config
    if (tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config)) {
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
  response.end(serializeBoundedJson(body, 30_000))
}
