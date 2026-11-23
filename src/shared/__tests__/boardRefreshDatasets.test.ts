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

describe('boardRefreshWidgetDatasets (scoped snapshot)', () => {
  it('keeps an empty TikTok snapshot empty when the shared dataset contains another account', () => {
    const result: BoardRefreshResult = {
      ok: true, boardId: 'b', runId: 'r', planKey: 'p',
      reportWindow: { start: '2026-11-22', end: '2026-11-22' }, generatedAt: 1, status: 'ready',
      sources: [{ key: 'tt:111', kind: 'tiktok', status: 'empty', window: { start: '2026-11-22', end: '2026-11-22' }, dataset: full('tt', 'TikTok 报表', []) }],
      widgets: [{ widgetId: 'w1', window: { start: '2026-11-22', end: '2026-11-22' }, status: 'empty', bindings: [{ datasetId: 'tt', sourceKey: 'tt:111', window: { start: '2026-11-22', end: '2026-11-22' } }] }]
    }
    const shared = full('tt', 'TikTok 报表', [['2026-11-22', 99, '222']])
    shared.columns.push({ name: '广告主ID', type: 'text' })
    const bound = boardRefreshWidgetDatasets(result, widget('w1', 'tt'), [shared]).find(dataset => dataset.id === 'tt')
    expect(bound?.rows).toEqual([])
    expect(bound?.name).toBe('TikTok 报表')
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
