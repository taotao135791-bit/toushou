import type { BoardMasterScope, BoardWidget, KanbanBoard } from './types'
import { boardReadingRangeDates } from './fbReading'
import { boardWidgetDatasetBindings } from './boardDataWidgets'

export interface BoardDateWindow { start: string; end: string }
export type BoardWidgetDateScope =
  | { mode: 'inherit' }
  | { mode: 'lookback'; days: number; anchor: 'reportEnd' }
  | { mode: 'absolute'; start: string; end: string }

export function isBoardDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function validateWidgetDateScope(raw: unknown): BoardWidgetDateScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.mode === 'inherit' && Object.keys(value).length === 1) return { mode: 'inherit' }
  if (value.mode === 'lookback' && Object.keys(value).every(key => ['mode', 'days', 'anchor'].includes(key)) && value.anchor === 'reportEnd' && Number.isSafeInteger(value.days) && Number(value.days) >= 1 && Number(value.days) <= 30) return { mode: 'lookback', days: Number(value.days), anchor: 'reportEnd' }
  if (value.mode === 'absolute' && Object.keys(value).every(key => ['mode', 'start', 'end'].includes(key)) && isBoardDate(value.start) && isBoardDate(value.end) && value.start <= value.end && Date.parse(value.end) - Date.parse(value.start) < 366 * 86_400_000) return { mode: 'absolute', start: value.start, end: value.end }
  return null
}
export function boardReportWindow(board: Pick<KanbanBoard, 'masterScope'>, now = Date.now()): BoardDateWindow {
  const range: BoardMasterScope['range'] = board.masterScope?.range ?? 'last7'
  if (range !== 'yesterday') return boardReadingRangeDates(range, new Date(now))
  const day = new Date(now); day.setDate(day.getDate() - 1)
  const value = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return { start: value, end: value }
}
export function boardWidgetWindow(board: Pick<KanbanBoard, 'masterScope'>, widget: Pick<BoardWidget, 'dateScope'> & Partial<Pick<BoardWidget, 'config' | 'type'>>, now = Date.now()): BoardDateWindow {
  const report = boardReportWindow(board, now), scope = widget.dateScope
  if (!scope && widget.config?.independent === true) {
    const range = widget.config.range
    if (range === 'today' || range === 'yesterday' || range === 'last3' || range === 'last7' || range === 'last30') return boardReportWindow({ masterScope: { range, metrics: [] } }, now)
    if (widget.type === 'tt-reading' && ['1', 'yd', '3', '7', '28', '30'].includes(String(range))) {
      if (range === '1') return boardReportWindow({ masterScope: { range: 'today', metrics: [] } }, now)
      const end = boardReportWindow({ masterScope: { range: 'yesterday', metrics: [] } }, now).end
      return { start: new Date(Date.parse(`${end}T00:00:00Z`) - ((range === 'yd' ? 1 : Number(range)) - 1) * 86_400_000).toISOString().slice(0, 10), end }
    }
  }
  if (!scope || scope.mode === 'inherit') return report
  if (scope.mode === 'absolute') return { start: scope.start, end: scope.end }
  return { start: new Date(Date.parse(`${report.end}T00:00:00Z`) - (scope.days - 1) * 86_400_000).toISOString().slice(0, 10), end: report.end }
}
/** Only query inputs participate; cosmetic edits preserve the published read. */
export function boardRefreshPlanKey(board: KanbanBoard): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value
  return JSON.stringify(canonical([board.id, board.masterScope ?? null, board.widgets.filter(widget => boardWidgetDatasetBindings(widget).length > 0 || ['tt-reading', 'meta-reading', 'fb-reading', 'fb-reading-summary', 'fb-report-reading', 'google-report-reading'].includes(widget.type)).map(widget => [widget.id, widget.type, widget.dateScope ?? null, widget.config])]))
}
export function boardWindowLabel(window: BoardDateWindow): string { return window.start === window.end ? window.start : `${window.start} – ${window.end}` }
