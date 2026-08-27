/**
 * Pure half of the widget boards: model factories, grid-layout helpers and
 * structural validation, with no filesystem access (that lives in
 * src/main/boards.ts). Kept in shared/ so the renderer can reuse the
 * factories/helpers and the main process can validate everything crossing
 * IPC or coming back from disk — including migrating v1 kanban files
 * (columns of cards) into v2 widget boards.
 */
import {
  BoardStyle,
  BoardWidget,
  BoardWidgetLayout,
  BoardWidgetStyle,
  KanbanBoard,
  WidgetType
} from './types'
import { DATASET_LIMITS, DATASET_OPS, DatasetOp } from './datasets'

export const BOARD_LIMITS = {
  maxBoards: 50,
  maxWidgets: 100,
  maxNameLength: 200,
  maxDescriptionLength: 2000,
  maxWidgetTitleLength: 200,
  maxNoteLength: 5000,
  maxLabelLength: 100,
  maxChartPoints: 200,
  maxChartLabelLength: 50,
  maxTodoItems: 200,
  maxTodoTextLength: 500,
  maxUrlLength: 2000,
  maxIdLength: 100,
  minWidgetRadius: 0,
  maxWidgetRadius: 32,
  minWidgetPadding: 6,
  maxWidgetPadding: 32
} as const

/** Widget grid geometry, shared by validation, layout helpers and the renderer. */
export const GRID_COLS = 12
export const GRID_MAX_H = 20

/** Outcome of a boards write; `error` is a stable code or an fs message. */
export type KanbanSaveResult = { ok: true } | { ok: false; error: string }

export const WIDGET_TYPES: readonly WidgetType[] = [
  'clock',
  'note',
  'counter',
  'gauge',
  'chart-line',
  'chart-bar',
  'todo',
  'link'
]

/** One todo-list entry, stored under the todo widget's `config.items`. */
export interface TodoItem {
  id: string
  text: string
  done: boolean
}

// ---------------------------------------------------------------------------
// Factories — the renderer supplies localized display text (widget titles),
// this layer owns structure and defaults.
// ---------------------------------------------------------------------------

export const WIDGET_DEFAULT_SIZES: Record<WidgetType, { w: number; h: number }> = {
  clock: { w: 3, h: 3 },
  note: { w: 3, h: 3 },
  counter: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  'chart-line': { w: 6, h: 4 },
  'chart-bar': { w: 6, h: 4 },
  todo: { w: 4, h: 5 },
  link: { w: 3, h: 2 }
}

export function defaultWidgetConfig(type: WidgetType): Record<string, unknown> {
  switch (type) {
    case 'clock':
      return { showSeconds: true }
    case 'note':
      return { text: '' }
    case 'counter':
      return { value: 0, label: '' }
    case 'gauge':
      return { value: 50, label: '' }
    case 'chart-line':
    case 'chart-bar':
      return { points: [3, 5, 4, 7, 6, 9, 8], labels: [] }
    case 'todo':
      return { items: [] }
    case 'link':
      return { url: 'https://example.com' }
  }
}

export function createBoard(name: string, now: number = Date.now()): KanbanBoard {
  return { id: crypto.randomUUID(), name, widgets: [], createdAt: now, updatedAt: now }
}

/** `title` is display text supplied by the caller (the localized type name). */
export function createWidget(
  type: WidgetType,
  title: string,
  slot: { x: number; y: number }
): BoardWidget {
  const size = WIDGET_DEFAULT_SIZES[type]
  return {
    id: crypto.randomUUID(),
    type,
    title,
    layout: { x: slot.x, y: slot.y, w: size.w, h: size.h },
    config: defaultWidgetConfig(type)
  }
}

// ---------------------------------------------------------------------------
// Board composition — the "describe your board" dialog: deterministic,
// local-only keyword matching onto a handful of presets (no AI, no network).
// Display text (board names, widget titles, labels, todo items) comes from
// the caller's translator at creation time and is stored as plain strings.
// ---------------------------------------------------------------------------

/** Translator shape the presets need; the renderer passes its i18n `t`. */
export type BoardText = (key: string) => string

export type BoardPresetId = 'ads' | 'finance' | 'daily' | 'blank'

export interface ComposedBoard {
  name: string
  widgets: BoardWidget[]
}

// ASCII keywords match on word boundaries so "tt" doesn't fire inside
// "button"; CJK keywords match as plain substrings.
const ADS_KEYWORDS = [
  '广告',
  '投放',
  '谷歌',
  '消耗',
  'google',
  'fb',
  'facebook',
  'meta',
  'tiktok',
  'tt',
  'roas'
]
const FINANCE_KEYWORDS = ['财经', '股票', 'clock', 'stock']

function matchesKeyword(text: string, keyword: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]+$/.test(keyword)) return new RegExp(`\\b${keyword}\\b`).test(text)
  return text.includes(keyword)
}

/** Pick a preset from a free-form description; anything unknown falls back to daily. */
export function detectPreset(description: string): BoardPresetId {
  const text = description.toLowerCase()
  if (ADS_KEYWORDS.some((k) => matchesKeyword(text, k))) return 'ads'
  if (FINANCE_KEYWORDS.some((k) => matchesKeyword(text, k))) return 'finance'
  return 'daily'
}

function presetWidget(
  type: WidgetType,
  title: string,
  layout: BoardWidgetLayout,
  config: Record<string, unknown>
): BoardWidget {
  return { id: crypto.randomUUID(), type, title, layout, config }
}

/**
 * Overseas ad-ops board: a row of zeroed KPI counters, daily-spend trend and
 * per-channel comparison charts, then budget pacing, an optimization
 * checklist and a notes pad. All values are placeholders the user edits.
 */
export function overseasAdsPreset(t: BoardText): BoardWidget[] {
  const kpi = (titleKey: string, x: number): BoardWidget =>
    presetWidget('counter', t(titleKey), { x, y: 0, w: 3, h: 3 }, { value: 0 })
  return [
    kpi('boards.preset.ads.kpiSpend', 0),
    kpi('boards.preset.ads.kpiImpressions', 3),
    kpi('boards.preset.ads.kpiClicks', 6),
    kpi('boards.preset.ads.kpiConversions', 9),
    presetWidget(
      'chart-line',
      t('boards.preset.ads.trend'),
      { x: 0, y: 3, w: 6, h: 6 },
      { points: [320, 410, 380, 460, 520, 490, 560], labels: [] }
    ),
    presetWidget(
      'chart-bar',
      t('boards.preset.ads.channels'),
      { x: 6, y: 3, w: 6, h: 6 },
      { points: [1240, 980, 640], labels: ['Google', 'Meta', 'TikTok'] }
    ),
    presetWidget(
      'gauge',
      t('boards.preset.ads.budget'),
      { x: 0, y: 9, w: 4, h: 5 },
      { value: 0, label: t('boards.preset.ads.budgetLabel') }
    ),
    presetWidget(
      'todo',
      t('boards.preset.ads.todo'),
      { x: 4, y: 9, w: 4, h: 6 },
      {
        items: [
          'boards.preset.ads.todoSearchTerms',
          'boards.preset.ads.todoCreatives',
          'boards.preset.ads.todoBudget',
          'boards.preset.ads.todoTracking'
        ].map((key) => ({ id: crypto.randomUUID(), text: t(key), done: false }))
      }
    ),
    presetWidget('note', t('boards.preset.ads.note'), { x: 8, y: 9, w: 4, h: 5 }, { text: '' })
  ]
}

/** Market-watch board: clock, a "latest price" KPI and a price-trend chart. */
export function financePreset(t: BoardText): BoardWidget[] {
  return [
    presetWidget('clock', t('boards.widget.clock'), { x: 0, y: 0, w: 3, h: 3 }, { showSeconds: true }),
    presetWidget('counter', t('boards.preset.finance.kpi'), { x: 3, y: 0, w: 3, h: 3 }, { value: 0 }),
    presetWidget(
      'chart-line',
      t('boards.preset.finance.trend'),
      { x: 6, y: 0, w: 6, h: 5 },
      { points: [12.4, 12.1, 12.6, 12.3, 12.9, 13.2, 13.0], labels: [] }
    )
  ]
}

/** Everyday board: clock, a blank note and an empty todo list. */
export function dailyPreset(t: BoardText): BoardWidget[] {
  return [
    presetWidget('clock', t('boards.widget.clock'), { x: 0, y: 0, w: 3, h: 3 }, { showSeconds: true }),
    presetWidget('note', t('boards.widget.note'), { x: 3, y: 0, w: 3, h: 3 }, { text: '' }),
    presetWidget('todo', t('boards.widget.todo'), { x: 6, y: 0, w: 4, h: 5 }, { items: [] })
  ]
}

/**
 * Deterministically compose a new board from a free-form description. A
 * chip-selected `preset` skips keyword detection entirely. The caller turns
 * the result into a real board via `createBoard` and switches to it.
 */
export function composeBoard(
  description: string,
  t: BoardText,
  preset?: BoardPresetId
): ComposedBoard {
  const id = preset ?? detectPreset(description)
  switch (id) {
    case 'ads':
      return { name: t('boards.preset.ads'), widgets: overseasAdsPreset(t) }
    case 'finance':
      return { name: t('boards.preset.finance'), widgets: financePreset(t) }
    case 'blank':
      return { name: t('boards.preset.blank'), widgets: [] }
    default:
      return { name: t('boards.preset.daily'), widgets: dailyPreset(t) }
  }
}

// ---------------------------------------------------------------------------
// Layout helpers — pure geometry on the 12-column grid.
// ---------------------------------------------------------------------------

function overlaps(a: BoardWidgetLayout, b: BoardWidgetLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** First free slot for a w×h widget, scanning top-to-bottom, left-to-right. */
export function findFreeSlot(
  widgets: BoardWidget[],
  w: number,
  h: number
): { x: number; y: number } {
  const bottom = widgets.reduce((m, wg) => Math.max(m, wg.layout.y + wg.layout.h), 0)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const candidate = { x, y, w, h }
      if (!widgets.some((wg) => overlaps(candidate, wg.layout))) return { x, y }
    }
  }
  return { x: 0, y: bottom }
}

/** "Tidy": push every widget straight up until it rests on another widget or the top. */
export function compactWidgets(widgets: BoardWidget[]): BoardWidget[] {
  const placed: BoardWidget[] = []
  const sorted = [...widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  for (const widget of sorted) {
    const layout = { ...widget.layout }
    while (layout.y > 0 && !placed.some((p) => overlaps({ ...layout, y: layout.y - 1 }, p.layout))) {
      layout.y -= 1
    }
    placed.push({ ...widget, layout })
  }
  // Keep the original array order — only layouts change.
  return widgets.map((w) => placed.find((p) => p.id === w.id) ?? w)
}

/** "Reset": reflow widgets in array order, row by row, keeping their sizes. */
export function reflowWidgets(widgets: BoardWidget[]): BoardWidget[] {
  let x = 0
  let y = 0
  let rowH = 0
  return widgets.map((widget) => {
    if (x + widget.layout.w > GRID_COLS) {
      x = 0
      y += rowH
      rowH = 0
    }
    const next = { ...widget, layout: { ...widget.layout, x, y } }
    x += widget.layout.w
    rowH = Math.max(rowH, widget.layout.h)
    return next
  })
}

// ---------------------------------------------------------------------------
// Validation — strict at the board level (bad board fields reject the whole
// board), lenient per widget: an invalid widget is dropped, never throws.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= BOARD_LIMITS.maxIdLength &&
    !CONTROL_RE.test(value)
  )
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function cleanNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cleanString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** Color inputs are rendered as style attributes, never as raw CSS strings. */
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

function cleanHexColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toLowerCase() : null
}

function cleanBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null
  return value >= min && value <= max ? value : null
}

/**
 * Cosmetic fields are intentionally lenient: a malformed saved style is
 * dropped while the user's underlying widget remains usable.
 */
export function validateBoardWidgetStyle(raw: unknown): BoardWidgetStyle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const style: BoardWidgetStyle = {}
  for (const key of ['accent', 'surface', 'text', 'border'] as const) {
    if (value[key] === undefined) continue
    const color = cleanHexColor(value[key])
    if (color === null) return undefined
    style[key] = color
  }
  if (value.radius !== undefined) {
    const radius = cleanBoundedInt(value.radius, BOARD_LIMITS.minWidgetRadius, BOARD_LIMITS.maxWidgetRadius)
    if (radius === null) return undefined
    style.radius = radius
  }
  if (value.padding !== undefined) {
    const padding = cleanBoundedInt(value.padding, BOARD_LIMITS.minWidgetPadding, BOARD_LIMITS.maxWidgetPadding)
    if (padding === null) return undefined
    style.padding = padding
  }
  if (value.titleAlign !== undefined) {
    if (value.titleAlign !== 'left' && value.titleAlign !== 'center' && value.titleAlign !== 'right') return undefined
    style.titleAlign = value.titleAlign
  }
  if (value.shadow !== undefined) {
    if (value.shadow !== 'none' && value.shadow !== 'soft' && value.shadow !== 'strong') return undefined
    style.shadow = value.shadow
  }
  return Object.keys(style).length > 0 ? style : undefined
}

/** Canvas style follows the same no-arbitrary-CSS policy as widget styles. */
export function validateBoardStyle(raw: unknown): BoardStyle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const style: BoardStyle = {}
  if (value.background !== undefined) {
    const background = cleanHexColor(value.background)
    if (background === null) return undefined
    style.background = background
  }
  if (value.grid !== undefined) {
    if (value.grid !== 'none' && value.grid !== 'dots' && value.grid !== 'lines') return undefined
    style.grid = value.grid
  }
  return Object.keys(style).length > 0 ? style : undefined
}

/**
 * Link widgets may only point at https URLs or http on the loopback host
 * (the same policy the main process enforces when opening external URLs).
 */
export function isValidLinkUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > BOARD_LIMITS.maxUrlLength ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    // Match Main's safeLoginExternalUrl policy exactly: credentials must not
    // be stored in a board URL or handed to the system browser.
    if (!url.hostname || url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

function validateLayout(raw: unknown): BoardWidgetLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const x = cleanNumber(l.x)
  const y = cleanNumber(l.y)
  const w = cleanNumber(l.w)
  const h = cleanNumber(l.h)
  if (x === null || y === null || w === null || h === null) return null
  const layout: BoardWidgetLayout = {
    x: Math.floor(x),
    y: Math.floor(y),
    w: Math.floor(w),
    h: Math.floor(h)
  }
  if (layout.x < 0 || layout.x > GRID_COLS - 1) return null
  if (layout.w < 1 || layout.w > GRID_COLS) return null
  if (layout.x + layout.w > GRID_COLS) return null
  if (layout.h < 1 || layout.h > GRID_MAX_H) return null
  if (layout.y < 0) return null
  return layout
}

/**
 * Dataset-binding branch shared by the counter/chart configs. Binding fields
 * (datasetId/metric/op/dimension) are validated whenever present so they
 * survive manual↔dataset toggles; source 'dataset' additionally requires
 * datasetId/metric/op (and dimension for charts). Returns false to drop the
 * widget; otherwise whitelisted fields are copied into `config`.
 */
function validateSourceBranch(
  raw: Record<string, unknown>,
  config: Record<string, unknown>,
  requireDimension: boolean
): boolean {
  const source = raw.source
  if (source !== undefined && source !== 'manual' && source !== 'dataset') return false
  let datasetId = ''
  let metric = ''
  let dimension = ''
  let op: DatasetOp | undefined
  if (raw.datasetId !== undefined) {
    if (
      typeof raw.datasetId !== 'string' ||
      raw.datasetId.length > DATASET_LIMITS.maxIdLength ||
      CONTROL_RE.test(raw.datasetId)
    ) {
      return false
    }
    datasetId = raw.datasetId
  }
  for (const key of ['metric', 'dimension'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (
      typeof value !== 'string' ||
      value.length > DATASET_LIMITS.maxColumnNameLength ||
      CONTROL_RE.test(value)
    ) {
      return false
    }
    if (key === 'metric') metric = value
    else dimension = value
  }
  if (raw.op !== undefined) {
    if (typeof raw.op !== 'string' || !DATASET_OPS.includes(raw.op as DatasetOp)) return false
    op = raw.op as DatasetOp
  }
  if (source === 'dataset') {
    if (!datasetId || !metric || !op) return false
    if (requireDimension && !dimension) return false
  }
  if (source !== undefined) config.source = source
  if (datasetId) config.datasetId = datasetId
  if (metric) config.metric = metric
  if (dimension) config.dimension = dimension
  if (op) config.op = op
  return true
}

/**
 * Per-type config whitelist. Returns a sanitized config (unknown keys
 * stripped, defaults applied for absent keys) or null to drop the widget.
 */
function validateWidgetConfig(
  type: WidgetType,
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  switch (type) {
    case 'clock': {
      const config: Record<string, unknown> = {}
      if (raw.showSeconds !== undefined) {
        if (typeof raw.showSeconds !== 'boolean') return null
        config.showSeconds = raw.showSeconds
      }
      return config
    }
    case 'note': {
      const config: Record<string, unknown> = {}
      if (raw.text !== undefined) {
        const text = cleanString(raw.text, BOARD_LIMITS.maxNoteLength)
        if (text === null) return null
        config.text = text
      }
      return config
    }
    case 'counter': {
      const config: Record<string, unknown> = {}
      if (raw.value !== undefined) {
        const value = cleanNumber(raw.value)
        if (value === null) return null
        config.value = value
      }
      if (raw.label !== undefined) {
        const label = cleanString(raw.label, BOARD_LIMITS.maxLabelLength)
        if (label === null) return null
        if (label) config.label = label
      }
      if (!validateSourceBranch(raw, config, false)) return null
      return config
    }
    case 'gauge': {
      const config: Record<string, unknown> = {}
      if (raw.value !== undefined) {
        const value = cleanNumber(raw.value)
        if (value === null || value < 0 || value > 100) return null
        config.value = value
      }
      if (raw.label !== undefined) {
        const label = cleanString(raw.label, BOARD_LIMITS.maxLabelLength)
        if (label === null) return null
        if (label) config.label = label
      }
      return config
    }
    case 'chart-line':
    case 'chart-bar': {
      const config: Record<string, unknown> = {}
      if (raw.points !== undefined) {
        if (!Array.isArray(raw.points) || raw.points.length > BOARD_LIMITS.maxChartPoints) {
          return null
        }
        const points: number[] = []
        for (const p of raw.points) {
          const value = cleanNumber(p)
          if (value === null) return null
          points.push(value)
        }
        config.points = points
      }
      if (raw.labels !== undefined) {
        if (!Array.isArray(raw.labels) || raw.labels.length > BOARD_LIMITS.maxChartPoints) {
          return null
        }
        const labels: string[] = []
        for (const l of raw.labels) {
          const label = cleanString(l, BOARD_LIMITS.maxChartLabelLength)
          if (label === null) return null
          labels.push(label)
        }
        config.labels = labels
      }
      if (!validateSourceBranch(raw, config, true)) return null
      return config
    }
    case 'todo': {
      const config: Record<string, unknown> = {}
      if (raw.items !== undefined) {
        if (!Array.isArray(raw.items) || raw.items.length > BOARD_LIMITS.maxTodoItems) return null
        const items: TodoItem[] = []
        const seen = new Set<string>()
        for (const rawItem of raw.items) {
          // Item-level problems drop the item, not the widget.
          if (!rawItem || typeof rawItem !== 'object') continue
          const item = rawItem as Record<string, unknown>
          const text = cleanString(item.text, BOARD_LIMITS.maxTodoTextLength)
          if (!isValidId(item.id) || text === null || seen.has(item.id)) continue
          if (item.done !== undefined && typeof item.done !== 'boolean') continue
          seen.add(item.id)
          items.push({ id: item.id, text, done: item.done === true })
        }
        config.items = items
      }
      return config
    }
    case 'link': {
      // A link widget without a valid URL is useless — drop it entirely.
      if (!isValidLinkUrl(raw.url)) return null
      return { url: raw.url }
    }
  }
}

function validateWidget(raw: unknown): BoardWidget | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  if (!isValidId(w.id)) return null
  if (typeof w.type !== 'string' || !WIDGET_TYPES.includes(w.type as WidgetType)) return null
  if (typeof w.title !== 'string' || w.title.length > BOARD_LIMITS.maxWidgetTitleLength) return null
  const layout = validateLayout(w.layout)
  if (!layout) return null
  if (w.config !== undefined && (typeof w.config !== 'object' || w.config === null || Array.isArray(w.config))) {
    return null
  }
  const config = validateWidgetConfig(w.type as WidgetType, (w.config ?? {}) as Record<string, unknown>)
  if (!config) return null
  const style = validateBoardWidgetStyle(w.style)
  return { id: w.id, type: w.type as WidgetType, title: w.title, layout, config, ...(style ? { style } : {}) }
}

/**
 * Validate a board coming from disk or across IPC. Recovery reads retain the
 * historic behavior of dropping malformed widgets so one bad legacy entry
 * does not hide the rest of a board. Writes use `strict` so renderer input
 * can never silently truncate widgets or discard a widget after the UI has
 * reported a successful save.
 */
export function validateBoard(raw: unknown, strict = false): KanbanBoard | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (!isValidId(b.id)) return null
  if (
    typeof b.name !== 'string' ||
    !b.name.trim() ||
    b.name.length > BOARD_LIMITS.maxNameLength
  ) {
    return null
  }
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || b.description.length > BOARD_LIMITS.maxDescriptionLength)
  ) {
    return null
  }
  if (!Array.isArray(b.widgets)) return null
  if (strict && b.widgets.length > BOARD_LIMITS.maxWidgets) return null
  if (!isValidTimestamp(b.createdAt) || !isValidTimestamp(b.updatedAt)) return null
  const widgets: BoardWidget[] = []
  const seen = new Set<string>()
  const rawWidgets = strict ? b.widgets : b.widgets.slice(0, BOARD_LIMITS.maxWidgets)
  for (const rawWidget of rawWidgets) {
    const widget = validateWidget(rawWidget)
    if (!widget || seen.has(widget.id)) {
      if (strict) return null
      continue
    }
    seen.add(widget.id)
    widgets.push(widget)
  }
  const board: KanbanBoard = {
    id: b.id,
    name: b.name,
    widgets,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt
  }
  if (typeof b.description === 'string' && b.description.length > 0) {
    board.description = b.description
  }
  const style = validateBoardStyle(b.style)
  if (style) board.style = style
  return board
}

// ---------------------------------------------------------------------------
// v1 → v2 migration — v1 boards stored `columns: [{title, cards: [{title,
// note}]}]`; every column becomes a todo widget (cards → items), laid out
// three per row in column order. Template columns stored i18n keys as their
// title, which are mapped to plain text here (v2 stores display text only).
// ---------------------------------------------------------------------------

const LEGACY_COLUMN_TITLES: Record<string, string> = {
  'boards.col.todo': 'Todo',
  'boards.col.doing': 'In progress',
  'boards.col.done': 'Done',
  'boards.col.reported': 'Reported',
  'boards.col.confirmed': 'Confirmed',
  'boards.col.fixing': 'Fixing',
  'boards.col.closed': 'Closed',
  'boards.col.backlog': 'Backlog',
  'boards.col.thisWeek': 'This week',
  'boards.col.nextWeek': 'Next week',
  'boards.col.shipped': 'Shipped'
}

/**
 * Accepts v2 (widgets) and v1 (columns/cards) board JSON alike and returns a
 * valid v2 board, or null for anything unrecognizable. v2 input is just
 * validated; v1 input is converted and then validated like any v2 board.
 */
export function migrateBoard(raw: unknown): KanbanBoard | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (Array.isArray(b.widgets)) return validateBoard(raw)
  if (!Array.isArray(b.columns)) return null

  const widgets: BoardWidget[] = []
  const usedIds = new Set<string>()
  for (const rawColumn of b.columns.slice(0, BOARD_LIMITS.maxWidgets)) {
    if (!rawColumn || typeof rawColumn !== 'object') continue
    const column = rawColumn as Record<string, unknown>
    const rawTitle = typeof column.title === 'string' ? column.title : ''
    const title =
      (LEGACY_COLUMN_TITLES[rawTitle] ?? rawTitle).slice(0, BOARD_LIMITS.maxWidgetTitleLength) ||
      'Todo'
    const cards = Array.isArray(column.cards) ? column.cards : []
    const items: TodoItem[] = []
    for (const rawCard of cards.slice(0, BOARD_LIMITS.maxTodoItems)) {
      if (!rawCard || typeof rawCard !== 'object') continue
      const card = rawCard as Record<string, unknown>
      if (typeof card.title !== 'string' || !card.title.trim()) continue
      let id = isValidId(card.id) ? card.id : crypto.randomUUID()
      if (usedIds.has(id)) id = crypto.randomUUID()
      usedIds.add(id)
      items.push({ id, text: card.title.slice(0, BOARD_LIMITS.maxTodoTextLength), done: false })
    }
    let id = isValidId(column.id) ? column.id : crypto.randomUUID()
    if (usedIds.has(id)) id = crypto.randomUUID()
    usedIds.add(id)
    const i = widgets.length
    widgets.push({
      id,
      type: 'todo',
      title,
      layout: { x: (i % 3) * 4, y: Math.floor(i / 3) * 6, w: 4, h: 6 },
      config: { items }
    })
  }
  return validateBoard({
    id: b.id,
    name: b.name,
    widgets,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt
  })
}
