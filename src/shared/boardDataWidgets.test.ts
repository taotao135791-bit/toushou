import { describe, expect, it } from 'vitest'
import { boardWidgetDatasetBindings, validateDataTableConfig, validateFunnelConfig, validateAnalysisConfig } from './boardDataWidgets'
import { createBoard, createWidget, validateBoard } from './boards'

const persistedWidget = (widget: unknown) => validateBoard({ ...createBoard('Synthetic board'), widgets: [widget] }, true)?.widgets[0] ?? null

describe('source-backed business board modules', () => {
  it('stores only the table binding and rejects copied report rows or invalid display bounds', () => {
    const input = { source: 'dataset', datasetId: 'daily-report', columns: ['日期', '花费'], pageSize: 10, sortColumn: '日期', sortDirection: 'desc', filterColumn: '地区', filterValue: 'A' }
    expect(validateDataTableConfig(input)).toEqual(input)
    expect(validateDataTableConfig({ ...input, rows: [['2026-11-01', 100]] })).toBeNull()
    expect(validateDataTableConfig({ ...input, source: 'manual' })).toBeNull()
    expect(validateDataTableConfig({ ...input, columns: ['日期', '日期'] })).toBeNull()
    expect(validateDataTableConfig({ ...input, pageSize: 1000 })).toBeNull()
    expect(validateDataTableConfig({ ...input, filterColumn: '', filterValue: 'A' })).toBeNull()
  })

  it('preserves business stage order and every source through persistence validation', () => {
    const config = { source: 'dataset', stages: [
      { label: '触达', datasetId: 'media-report', metric: '访问量', op: 'sum' },
      { label: '试用', datasetId: 'attribution-trials', metric: '事件次数', op: 'sum', filterColumn: '事件', filterValue: 'trial_started' },
      { label: '成交', datasetId: 'attribution-sales', metric: '独立用户', op: 'max' }
    ] }
    const widget = createWidget('funnel', '业务路径', { x: 0, y: 0 }, config)
    const saved = persistedWidget(widget)
    expect(saved).not.toBeNull()
    expect((saved!.config.stages as Array<{ label: string }>).map(stage => stage.label)).toEqual(['触达', '试用', '成交'])
    expect(boardWidgetDatasetBindings(saved!).map(binding => binding.datasetId)).toEqual(['media-report', 'attribution-trials', 'attribution-sales'])
    expect(persistedWidget(saved)).toEqual(saved)
  })

  it('does not accept hand-filled funnel values or a single stage as a completed funnel', () => {
    const stage = { label: '完成', datasetId: 'report', metric: '事件次数' }
    expect(validateFunnelConfig({ source: 'dataset', stages: [stage] })).toBeNull()
    expect(validateFunnelConfig({ source: 'dataset', stages: [{ ...stage, value: 10 }, stage] })).toBeNull()
    expect(validateFunnelConfig({ source: 'dataset', stages: [stage, { ...stage, op: 'execute' }] })).toBeNull()
    expect(validateFunnelConfig({ source: 'manual', stages: [stage, stage] })).toBeNull()
  })

  it('keeps empty gallery modules unconfigured without inventing data', () => {
    for (const type of ['table', 'funnel', 'analysis'] as const) {
      const widget = createWidget(type, type, { x: 0, y: 0 })
      expect(persistedWidget(widget)).not.toBeNull()
      expect(boardWidgetDatasetBindings(widget)).toEqual([])
    }
  })

  it('binds highlights to a metric and optional dimension instead of saved prose', () => {
    const config = { source: 'dataset', datasetId: 'report', metric: '完成数', dimension: '日期', op: 'sum' }
    expect(validateAnalysisConfig(config)).toEqual(config)
    expect(validateAnalysisConfig({ ...config, text: 'An old observation' })).toBeNull()
    expect(validateAnalysisConfig({ ...config, op: 'eval' })).toBeNull()
  })
})
