import { describe, expect, it, vi } from 'vitest'

// boardWidgetAi imports the isolated-runtime helper, whose chain touches electron.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/board-widget-ai-test' } }))

import { validateProposal, type AiWidgetDatasetSummary } from '../boardWidgetAi'

const datasets: AiWidgetDatasetSummary[] = [{
  id: 'ds-1',
  name: 'AF-装',
  rowCount: 3,
  columns: [
    { name: 'Date', type: 'date' },
    { name: '安装', type: 'number' },
    { name: '活动', type: 'text' }
  ]
}]

describe('validateProposal (AI 看板卡片提案的硬校验)', () => {
  it('accepts a counter bound to a REAL numeric column', () => {
    const proposal = validateProposal({ type: 'counter', title: '安装数', config: { source: 'dataset', datasetId: 'ds-1', metric: '安装', op: 'sum' }, reason: 'r' }, datasets)
    expect(proposal).toMatchObject({ type: 'counter', title: '安装数', config: { source: 'dataset', datasetId: 'ds-1', metric: '安装', op: 'sum' } })
  })

  it('rejects invented dataset ids, columns and non-numeric metrics', () => {
    expect(validateProposal({ type: 'counter', title: 'x', config: { datasetId: 'ghost', metric: '安装' } }, datasets)).toBeNull()
    expect(validateProposal({ type: 'counter', title: 'x', config: { datasetId: 'ds-1', metric: '留存率' } }, datasets)).toBeNull()
    // text column cannot be a summed metric
    expect(validateProposal({ type: 'counter', title: 'x', config: { datasetId: 'ds-1', metric: '活动' } }, datasets)).toBeNull()
    expect(validateProposal({ type: 'counter', title: 'x', config: { datasetId: 'ds-1', metric: '安装', op: 'median' } }, datasets)?.config.op).toBe('sum')
  })

  it('keeps only real table columns and caps them at 12', () => {
    const proposal = validateProposal({ type: 'table', title: '明细', config: { datasetId: 'ds-1', columns: ['Date', 'ghost', '安装'] } }, datasets)
    expect(proposal?.config.columns).toEqual(['Date', '安装'])
  })

  it('accepts notes without any dataset binding and rejects malformed shapes', () => {
    expect(validateProposal({ type: 'note', title: '说明', config: { text: '这是一段说明' } }, datasets)).toMatchObject({ type: 'note' })
    expect(validateProposal({ type: 'note', title: '说明', config: {} }, datasets)).toBeNull()
    expect(validateProposal({ type: 'weird', title: 'x', config: {} }, datasets)).toBeNull()
    expect(validateProposal(null, datasets)).toBeNull()
    expect(validateProposal({ type: 'counter', title: '', config: { datasetId: 'ds-1', metric: '安装' } }, datasets)).toBeNull()
  })

  it('validates every funnel stage against its own dataset', () => {
    const ok = validateProposal({ type: 'funnel', title: '漏斗', config: { stages: [
      { label: '安装', datasetId: 'ds-1', metric: '安装', op: 'sum' },
      { label: '再次', datasetId: 'ds-1', metric: '安装', op: 'sum' }
    ] } }, datasets)
    expect(ok?.config.stages).toHaveLength(2)
    const bad = validateProposal({ type: 'funnel', title: '漏斗', config: { stages: [
      { label: '安装', datasetId: 'ds-1', metric: 'ghost', op: 'sum' },
      { label: '再次', datasetId: 'ds-1', metric: '安装', op: 'sum' }
    ] } }, datasets)
    expect(bad).toBeNull()
  })
})
