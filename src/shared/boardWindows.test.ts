import { describe, expect, it } from 'vitest'
import { boardRefreshPlanKey, boardReportWindow, boardWidgetWindow, validateWidgetDateScope } from './boardWindows'
import { validateBoard } from './boards'
import type { BoardWidget, KanbanBoard } from './types'

const now = new Date(2030, 0, 2, 12).getTime()
const widget: BoardWidget = { id: 'trend', type: 'chart-line', title: 'Trend', layout: { x: 0, y: 0, w: 6, h: 4 }, config: { source: 'dataset', datasetId: 'synthetic', metric: 'Count', op: 'sum', dimension: 'Date' } }
const board: KanbanBoard = { id: 'synthetic-board', name: 'Daily', masterScope: { range: 'yesterday', metrics: ['spend'] }, widgets: [widget], createdAt: 1, updatedAt: 1 }
describe('board report and module windows', () => {
  it('anchors seven days to the selected report end across a year boundary', () => {
    expect(boardReportWindow(board, now)).toEqual({ start: '2030-01-01', end: '2030-01-01' })
    expect(boardWidgetWindow(board, { dateScope: { mode: 'lookback', days: 7, anchor: 'reportEnd' } }, now)).toEqual({ start: '2029-12-26', end: '2030-01-01' })
    expect(boardWidgetWindow({ masterScope: { range: 'today', metrics: [] } }, { dateScope: { mode: 'lookback', days: 7, anchor: 'reportEnd' } }, now)).toEqual({ start: '2029-12-27', end: '2030-01-02' })
  })
  it('preserves absolute live windows and old omitted-scope widgets', () => {
    const absolute = { mode: 'absolute' as const, start: '2028-02-28', end: '2028-02-29' }
    expect(boardWidgetWindow(board, { dateScope: absolute }, now)).toEqual({ start: absolute.start, end: absolute.end })
    expect(boardWidgetWindow(board, widget, now)).toEqual(boardReportWindow(board, now))
    expect(validateBoard({ ...board, widgets: [{ ...widget, dateScope: absolute }] }, true)?.widgets[0].dateScope).toEqual(absolute)
    expect(boardWidgetWindow(board, { type: 'tt-reading', config: { independent: true, range: '7' } }, now)).toEqual({ start: '2029-12-26', end: '2030-01-01' })
  })
  it('rejects malformed or unbounded date contracts and ignores cosmetic edits in query identity', () => {
    for (const raw of [{ mode: 'lookback', days: 0, anchor: 'reportEnd' }, { mode: 'lookback', days: 7, anchor: 'today' }, { mode: 'absolute', start: '2030-02-30', end: '2030-03-01' }, { mode: 'inherit', extra: 1 }]) expect(validateWidgetDateScope(raw)).toBeNull()
    expect(boardRefreshPlanKey(board)).toBe(boardRefreshPlanKey({ ...board, name: 'New title', style: { background: '#ffffff' }, widgets: [{ ...widget, title: 'Another title', layout: { x: 0, y: 3, w: 12, h: 4 } }] }))
    expect(boardRefreshPlanKey(board)).not.toBe(boardRefreshPlanKey({ ...board, widgets: [{ ...widget, dateScope: { mode: 'lookback', days: 7, anchor: 'reportEnd' } }] }))
  })
})
