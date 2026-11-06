import { describe, expect, it } from 'vitest'
import type { BoardDataset, BoardWidget, KanbanBoard } from '@shared/types'
import { boardAppsFlyerDatasetIds, boardMasterWindow, boardRefreshWindow, boardScopeCounts, boardScopedBoardTitle, boardScopedWidgetTitle, datasetsForBoardWindow } from './boardRefreshScope'

const widget = (id: string, type: BoardWidget['type'], config: Record<string, unknown>, title = id): BoardWidget => ({ id, type, title, config, layout: { x: 0, y: 0, w: 3, h: 3 } })
const board = (widgets: BoardWidget[]): KanbanBoard => ({ id: 'board', name: 'Synthetic', widgets, createdAt: 1, updatedAt: 1 })
const dataset = (id: string, name = 'AF-Synthetic'): BoardDataset => ({ id, name, columns: [{ name: '日期', type: 'date' }, { name: '次数', type: 'number' }], rows: [['2026-11-04', 99]], createdAt: 1 })
const window = { start: '2026-11-05', end: '2026-11-05' }

describe('board refresh scope', () => {
  it('uses concrete inclusive day windows while preserving the existing last-seven-day definition', () => {
    const now = new Date(2026, 10, 6, 12)
    expect(boardMasterWindow('last7', now)).toEqual({ start: '2026-10-30', end: '2026-11-05' })
    expect(boardMasterWindow('yesterday', now)).toEqual(window)
    expect(boardMasterWindow('today', now)).toEqual({ start: '2026-11-06', end: '2026-11-06' })
  })

  it('refreshes only AF datasets bound to this board, resolving names to stable IDs', () => {
    const a = dataset('af-a'), b = dataset('af-b', 'AF-Other app')
    const target = board([widget('a', 'counter', { source: 'dataset', datasetId: a.name }), widget('a2', 'chart-line', { source: 'dataset', datasetId: a.id }), widget('missing', 'counter', { source: 'dataset', datasetId: 'AF-Missing recipe' }), widget('manual', 'counter', { source: 'manual', datasetId: b.id })])
    expect(boardAppsFlyerDatasetIds(target, [a, b])).toEqual(['AF-Missing recipe', 'af-a'])
    expect(boardRefreshWindow(target, [a, b], new Date(2026, 10, 6))).toEqual({ start: '2026-11-04', end: '2026-11-04' })
  })

  it('keeps the attempted date window after an empty result clears all rows', () => {
    const a = { ...dataset('af-a'), rows: [], appsflyer: { status: 'empty' as const, window, attemptedAt: 1 } }
    expect(boardRefreshWindow(board([widget('a', 'counter', { source: 'dataset', datasetId: a.id })]), [a])).toEqual(window)
  })

  it('refreshes every source used inside a funnel and a daily table without unrelated data', () => {
    const a = dataset('af-a'), b = dataset('af-b'), other = dataset('af-other')
    const target = board([
      widget('funnel', 'funnel', { source: 'dataset', stages: [
        { label: 'Synthetic acquisition', datasetId: a.id, metric: '次数' },
        { label: 'Synthetic purchase', datasetId: b.id, metric: '次数' }
      ] }),
      widget('daily', 'table', { source: 'dataset', datasetId: a.id }),
      widget('analysis', 'analysis', { source: 'dataset', datasetId: b.id, metric: '次数' })
    ])
    expect(boardAppsFlyerDatasetIds(target, [a, b, other])).toEqual(['af-a', 'af-b'])
  })

  it('distinguishes live, independent and fixed modules without counting explanatory notes', () => {
    const a = { ...dataset('af-a'), appsflyer: { specId: 'query-a', status: 'updated' as const, window, dataWindow: window, attemptedAt: 1 } }
    const target = board([widget('media', 'tt-reading', { range: '7' }), widget('af', 'counter', { source: 'dataset', datasetId: a.id }), widget('fixed', 'counter', { source: 'manual', value: 5 }), widget('note', 'note', { text: 'Explanation' }), widget('google', 'google-report-reading', {})])
    expect(boardScopeCounts(target, [a])).toEqual({ live: 2, fixed: 1, independent: 1, unbound: 0 })
  })

  it('does not claim disconnected AF cards follow the master', () => {
    const a = dataset('af-a')
    const target = board([widget('af', 'counter', { source: 'dataset', datasetId: a.id })])
    expect(boardScopeCounts(target, [a])).toEqual({ live: 0, fixed: 0, independent: 0, unbound: 1 })
    expect(boardScopeCounts(target, [{ ...a, appsflyer: { status: 'unbound', window, attemptedAt: 1 } }]).live).toBe(0)
    expect(boardScopeCounts(board([widget('missing', 'counter', { source: 'dataset', datasetId: 'AF-Removed' })]), [])).toEqual({ live: 0, fixed: 0, independent: 0, unbound: 1 })
  })

  it('updates stale range titles while retaining fixed snapshot and custom business titles', () => {
    const master = { range: 'yesterday' as const, metrics: ['spend'] }
    expect(boardScopedWidgetTitle(widget('reader', 'tt-reading', {}, 'TT 读数 · Synthetic（近 7 天）'), master, 'zh')).toBe('TT 读数 · Synthetic（昨天）')
    expect(boardScopedWidgetTitle(widget('chart', 'chart-line', { source: 'dataset' }, '近 30 天消耗趋势'), master, 'zh')).toBe('昨天消耗趋势')
    expect(boardScopedWidgetTitle(widget('fixed', 'counter', { source: 'manual' }, '近7天固定快照'), master, 'zh')).toBe('近7天固定快照')
    expect(boardScopedWidgetTitle(widget('custom', 'counter', { source: 'dataset' }, '注册'), master, 'zh')).toBe('注册')
  })

  it('keeps explicit report dates aligned after range changes without rewriting fixed titles or saved names', () => {
    const now = new Date(2026, 10, 6, 12)
    const master = { range: 'last7' as const, metrics: ['spend'] }
    const table = widget('daily', 'table', { source: 'dataset', datasetId: 'media' }, '活动日报（2026-11-05）')
    expect(boardScopedWidgetTitle(table, master, 'zh', now)).toBe('活动日报（2026-10-30～2026-11-05）')
    expect(boardScopedWidgetTitle({ ...table, title: 'Daily rows (10/31–11/06)' }, master, 'en', now)).toBe('Daily rows (2026-10-30～2026-11-05)')
    expect(boardScopedWidgetTitle({ ...table, title: '2026-11-05 目标' }, master, 'zh', now)).toBe('2026-11-05 目标')
    expect(boardScopedWidgetTitle({ ...table, title: '完成阶段（1/2）' }, master, 'zh', now)).toBe('完成阶段（1/2）')
    expect(boardScopedWidgetTitle({ ...table, config: { source: 'manual' } }, master, 'zh', now)).toBe(table.title)
    const target = { ...board([table]), name: '投放日报（2026-11-05）', masterScope: master }
    expect(boardScopedBoardTitle(target, now)).toBe('投放日报（2026-10-30～2026-11-05）')
    expect(target.name).toBe('投放日报（2026-11-05）')
    expect(boardScopedBoardTitle({ ...target, widgets: [widget('fixed', 'counter', { source: 'manual', value: 12 })] }, now)).toBe(target.name)
    const history = { ...table, dateScope: { mode: 'absolute' as const, start: '2026-10-01', end: '2026-10-01' } }
    expect(boardScopedBoardTitle({ ...target, name: '历史投放（2026-10-01）', widgets: [history] }, now)).toBe('历史投放（2026-10-01）')
    expect(boardScopedBoardTitle({ ...target, name: '趋势（2026-11-05）', masterScope: { ...master, range: 'yesterday' }, widgets: [{ ...table, dateScope: { mode: 'lookback', days: 7, anchor: 'reportEnd' } }] }, now)).toBe('趋势（2026-10-30～2026-11-05）')
  })

  it('masks old, failed and unbound AF values until the requested window finishes, without changing stored rows', () => {
    const old = dataset('af-a'), other = dataset('af-b', 'AF-Unrelated')
    expect(datasetsForBoardWindow([old, other], [old.id], window, false)).toEqual([{ ...old, rows: [] }, other])
    for (const status of ['failed', 'unbound'] as const) {
      const failed = { ...old, appsflyer: { status, window, dataWindow: { start: '2026-11-04', end: '2026-11-04' }, attemptedAt: 1 } }
      expect(datasetsForBoardWindow([failed], [old.id], window, false)[0].rows).toEqual([])
    }
    const fresh = { ...old, appsflyer: { status: 'updated' as const, window, dataWindow: window, attemptedAt: 1 }, rows: [['2026-11-05', 5]] }
    expect(datasetsForBoardWindow([fresh], [old.id], window, false)[0]).toBe(fresh)
    expect(datasetsForBoardWindow([fresh], [old.id], window, true)[0].rows).toEqual([])
    expect(datasetsForBoardWindow([{ ...fresh, appsflyer: { ...fresh.appsflyer, dataWindow: { start: '2026-11-04', end: '2026-11-04' } } }], [old.id], window, false)[0].rows).toEqual([])
    expect(old.rows).toEqual([['2026-11-04', 99]])
  })
})
