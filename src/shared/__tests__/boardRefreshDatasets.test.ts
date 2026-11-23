import { describe, expect, it } from 'vitest'
import { boardRefreshWidgetDatasets, type BoardRefreshResult } from '../boardRefresh'
import type { BoardDataset, BoardWidget } from '../types'

const widget = (id: string, datasetId: string): BoardWidget =>
  ({ id, type: 'counter', title: id, layout: { x: 0, y: 0, w: 4, h: 4 }, config: { source: 'dataset', datasetId, metric: '安装', op: 'sum' } })

const full = (id: string, name: string, rows: Array<Array<string | number>>): BoardDataset => ({
  id, name, createdAt: 0,
  columns: [{ name: 'Date', type: 'date' }, { name: '安装', type: 'number' }],
  rows
})

describe('boardRefreshWidgetDatasets (slim-result row resolution)', () => {
  it('serves master-window rows from the reloaded store when the result carries a dataset brief', () => {
    // The agent-facing result is slimmed: sources carry {id,name,rowCount,columns} only.
    const result: BoardRefreshResult = {
      ok: true, boardId: 'b', runId: 'r', planKey: 'p',
      reportWindow: { start: '2026-11-22', end: '2026-11-22' }, generatedAt: 1, status: 'ready',
      sources: [{ key: 'af:1', kind: 'appsflyer', status: 'updated', window: { start: '2026-11-22', end: '2026-11-22' }, dataset: { id: 'mat-1', name: 'AF-装 · abc', createdAt: 0, columns: [{ name: 'Date', type: 'date' }, { name: '安装', type: 'number' }], rows: [] } }],
      widgets: [{ widgetId: 'w1', window: { start: '2026-11-22', end: '2026-11-22' }, status: 'updated', bindings: [{ datasetId: 'spec-1', sourceKey: 'af:1', window: { start: '2026-11-22', end: '2026-11-22' } }] }]
    }
    // The store (reloaded right after refresh) holds the materialization with rows.
    const store = [
      full('spec-1', 'AF-装', [['2026-11-15', 10], ['2026-11-21', 20]]),
      full('mat-1', 'AF-装 · abc', [['2026-11-22', 7]])
    ]
    const projected = boardRefreshWidgetDatasets(result, widget('w1', 'spec-1'), store)
    const bound = projected.find(dataset => dataset.id === 'spec-1')
    // The card sees yesterday's materialized rows, keeps the binding identity,
    // and records the resolved window so labels tell the truth.
    expect(bound?.rows).toEqual([['2026-11-22', 7]])
    expect(bound?.name).toBe('AF-装')
    expect(bound?.resolvedWindow).toEqual({ start: '2026-11-22', end: '2026-11-22' })
  })

  it('still projects embedded rows for Main-internal callers (full result shape)', () => {
    const result: BoardRefreshResult = {
      ok: true, boardId: 'b', runId: 'r', planKey: 'p',
      reportWindow: { start: '2026-11-22', end: '2026-11-22' }, generatedAt: 1, status: 'ready',
      sources: [{ key: 'af:1', kind: 'appsflyer', status: 'updated', window: { start: '2026-11-22', end: '2026-11-22' }, dataset: full('mat-9', 'AF-x', [['2026-11-22', 3]]) }],
      widgets: [{ widgetId: 'w2', window: { start: '2026-11-22', end: '2026-11-22' }, status: 'updated', bindings: [{ datasetId: 'spec-2', sourceKey: 'af:1' }] }]
    }
    const projected = boardRefreshWidgetDatasets(result, widget('w2', 'spec-2'), [full('spec-2', 'AF-x-old', [['2026-11-01', 99]])])
    expect(projected.find(dataset => dataset.id === 'spec-2')?.rows).toEqual([['2026-11-22', 3]])
  })

  it('returns the fallback untouched when the widget has no view bindings', () => {
    const result: BoardRefreshResult = {
      ok: true, boardId: 'b', runId: 'r', planKey: 'p',
      reportWindow: { start: '2026-11-22', end: '2026-11-22' }, generatedAt: 1, status: 'ready',
      sources: [], widgets: []
    }
    const store = [full('spec-3', 'AF-3', [['2026-11-22', 5]])]
    expect(boardRefreshWidgetDatasets(result, widget('w3', 'spec-3'), store)).toEqual(store)
  })
})
