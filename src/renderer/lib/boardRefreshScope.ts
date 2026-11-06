import type { BoardDataset, BoardMasterScope, BoardWidget, KanbanBoard, Language } from '@shared/types'
import { MASTER_SCOPED_WIDGET_TYPES } from '@shared/boards'
import { boardReadingRangeDates } from '@shared/fbReading'
import { boardWidgetDatasetBindings } from '@shared/boardDataWidgets'
import { boardWidgetWindow, boardWindowLabel } from '@shared/boardWindows'

export function boardMasterWindow(range: BoardMasterScope['range'], now = new Date()): { start: string; end: string } {
  if (range !== 'yesterday') return boardReadingRangeDates(range, now)
  const day = new Date(now)
  day.setDate(day.getDate() - 1)
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return { start: iso, end: iso }
}

export function isAppsFlyerDataset(dataset: BoardDataset): boolean {
  return !!dataset.appsflyer || dataset.name === 'AppsFlyer 报表' || dataset.name.startsWith('AF-')
}

/** Resolve only this board's bindings; never use the first AF dataset globally. */
export function boardAppsFlyerDatasetIds(board: KanbanBoard, datasets: BoardDataset[]): string[] {
  const ids = new Set<string>()
  for (const widget of board.widgets) {
    for (const { datasetId: binding } of boardWidgetDatasetBindings(widget)) {
      const dataset = datasets.find(item => item.id === binding) ?? datasets.find(item => item.name === binding)
      if (dataset ? isAppsFlyerDataset(dataset) : binding === 'AppsFlyer 报表' || binding.startsWith('AF-')) ids.add(dataset?.id ?? binding)
    }
  }
  return [...ids].sort()
}

export function boardRefreshWindow(board: KanbanBoard, datasets: BoardDataset[], now = new Date()): { start: string; end: string } {
  if (board.masterScope) return boardMasterWindow(board.masterScope.range, now)
  const bound = new Set(boardAppsFlyerDatasetIds(board, datasets))
  const selected = datasets.filter(dataset => bound.has(dataset.id))
  const windows = selected.flatMap(dataset => dataset.appsflyer ? [dataset.appsflyer.window] : [])
  if (windows.length && windows.every(window => window.start === windows[0].start && window.end === windows[0].end)) return windows[0]
  const days = selected.flatMap(dataset => {
    const index = dataset.columns.findIndex(column => column.type === 'date')
    return index < 0 ? [] : dataset.rows.map(row => String(row[index])).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day))
  }).sort()
  return days.length ? { start: days[0], end: days[days.length - 1] } : boardMasterWindow('last7', now)
}

/** Data modules only: notes and controls do not claim to follow a date. */
export function boardScopeCounts(board: KanbanBoard, datasets: BoardDataset[]): { live: number; fixed: number; independent: number; unbound: number } {
  let live = 0, fixed = 0, independent = 0, unbound = 0
  for (const widget of board.widgets) {
    if (widget.dateScope?.mode === 'absolute' || widget.config.independent === true || widget.type === 'google-report-reading') { independent++; continue }
    if (MASTER_SCOPED_WIDGET_TYPES.includes(widget.type)) { live++; continue }
    const bindings = boardWidgetDatasetBindings(widget)
    if (bindings.length) {
      let missing = false, follows = true
      for (const binding of bindings) {
        if (binding.datasetId.startsWith('meta-reading:')) {
          const reader = board.widgets.find(item => item.type === 'meta-reading' && item.id === binding.datasetId.slice('meta-reading:'.length))
          if (!reader || !reader.config.accountId) missing = true
          continue
        }
        const dataset = datasets.find(item => item.id === binding.datasetId || item.name === binding.datasetId)
        const afBound = dataset ? isAppsFlyerDataset(dataset) : binding.datasetId === 'AppsFlyer 报表' || binding.datasetId.startsWith('AF-')
        if (afBound && (!dataset?.appsflyer?.specId || dataset.appsflyer.status === 'unbound')) missing = true
        else if (!afBound && !dataset?.columns.some(column => column.type === 'date')) follows = false
      }
      if (missing) unbound++
      else if (follows) live++
      else fixed++
    } else if (['counter', 'chart-line', 'chart-bar', 'table', 'funnel', 'analysis', 'gauge', 'reading-module', 'reading-snapshot'].includes(widget.type)) fixed++
  }
  return { live, fixed, independent, unbound }
}

/** A trailing report date is display scope, not a permanent business label. */
function scopedDateSuffix(title: string, master: BoardMasterScope, now: Date, scopedWindow?: { start: string; end: string }): string {
  const window = scopedWindow ?? boardMasterWindow(master.range, now)
  const dates = window.start === window.end ? window.start : `${window.start}～${window.end}`
  return title.replace(/([（(]\s*|\s+|[·:：]\s*)(?:\d{4}-\d{2}-\d{2}(?:\s*(?:~|～|–|—|至|到|to|-)\s*\d{4}-\d{2}-\d{2})?|\d{2}\/\d{2}\s*(?:~|～|–|—|至|到|to|-)\s*\d{2}\/\d{2})(\s*[）)]?)$/i, (_match, prefix: string, suffix: string) => `${prefix}${dates}${suffix}`)
}

/** Display a live board's report-date suffix using its current range; never rewrite storage. */
export function boardScopedBoardTitle(board: KanbanBoard, now = new Date()): string {
  if (!board.masterScope) return board.name
  const modules = board.widgets.filter(widget => widget.config.independent !== true && (MASTER_SCOPED_WIDGET_TYPES.includes(widget.type) || boardWidgetDatasetBindings(widget).length > 0))
  if (!modules.length) return board.name
  const windows = modules.map(widget => boardWidgetWindow(board, widget, now.getTime()))
  const followsReport = modules.some(widget => !widget.dateScope || widget.dateScope.mode === 'inherit')
  const window = followsReport ? boardMasterWindow(board.masterScope.range, now) : windows.every(item => item.start === windows[0].start && item.end === windows[0].end) ? windows[0] : undefined
  return window ? scopedDateSuffix(board.name, board.masterScope, now, window) : board.name
}

/** Preserve custom business titles while replacing stale preset range text and report dates. */
export function boardScopedWidgetTitle(widget: BoardWidget, master: BoardMasterScope | null, language: Language, now = new Date()): string {
  if ((!master && !widget.dateScope) || widget.config.independent === true || !(MASTER_SCOPED_WIDGET_TYPES.includes(widget.type) || widget.config.source === 'dataset')) return widget.title
  const scope = master ?? { range: 'last7' as const, metrics: [] }, window = boardWidgetWindow({ masterScope: scope }, widget, now.getTime())
  const label = widget.dateScope?.mode === 'lookback' ? (language === 'zh' ? `近${widget.dateScope.days}天` : `Last ${widget.dateScope.days} days`) : widget.dateScope?.mode === 'absolute' ? boardWindowLabel(window) : (language === 'zh'
    ? { today: '今天', yesterday: '昨天', last3: '近3天', last7: '近7天', last30: '近30天' }
    : { today: 'Today', yesterday: 'Yesterday', last3: 'Last 3 days', last7: 'Last 7 days', last30: 'Last 30 days' })[scope.range]
  return scopedDateSuffix(widget.title, scope, now, window)
    .replace(/近\s*(?:3|7|28|30)\s*天|Last\s+(?:3|7|28|30)\s+days/gi, label)
    .replace(/(^|[（(\s·])(?:昨天|昨日|今天|Today|Yesterday)(?=$|[）)\s·])/gi, (_match, prefix: string) => `${prefix}${label}`)
}

/** A failed or old AF response must not populate cards under a new date. */
export function datasetsForBoardWindow(datasets: BoardDataset[], ids: string[], window: { start: string; end: string }, pending: boolean): BoardDataset[] {
  const selected = new Set(ids)
  return datasets.map(dataset => {
    if (!selected.has(dataset.id)) return dataset
    const state = dataset.appsflyer
    const ready = state && (state.status === 'updated' || state.status === 'empty') && state.window.start === window.start && state.window.end === window.end && state.dataWindow?.start === window.start && state.dataWindow.end === window.end
    return !pending && ready ? dataset : { ...dataset, rows: [] }
  })
}
