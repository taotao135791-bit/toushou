

import { describe, expect, it } from 'vitest'
import type { BoardDataset } from '../types'
import { safeMetricValue } from '../boardMetricSafety'

describe('percent-metric aggregation (留存率数据凸现)', () => {
  const dataset = (metric: string): BoardDataset => ({
    id: 'd', name: 'AF-Ret', createdAt: 0,
    columns: [{ name: 'Date', type: 'date' }, { name: metric, type: 'number' }],
    rows: [['2026-11-01', 46], ['2026-11-02', 50], ['2026-11-03', 42]]
  })

  it('multi-row SUM of a percent metric aggregates as the mean, not nonsense', () => {
    const d = dataset('Retention Day 1')
    expect(safeMetricValue(d, d.rows, 1, 'sum')).toBe(46)
  })

  it('single-row percent passes through unchanged', () => {
    const single = { ...dataset('留存率 D1'), rows: [['2026-11-01', 46.3]] } as BoardDataset
    expect(safeMetricValue(single, single.rows, 1, 'sum')).toBe(46.3)
  })

  it('keeps missing percentage values unknown and count fields additive', () => {
    const missing = dataset('D1 留存率')
    missing.rows = [['2026-11-01', ''], ['2026-11-02', '']]
    expect(safeMetricValue(missing, missing.rows, 1, 'sum')).toBeNull()
    missing.rows[1][1] = 43
    expect(safeMetricValue(missing, missing.rows, 1, 'sum')).toBeNull()
    for (const name of ['Churned users', 'Retention users', '留存用户数']) {
      const count = dataset(name)
      expect(safeMetricValue(count, count.rows, 1, 'sum')).toBe(138)
    }
  })

  it('weighted ratios (CTR) keep their numerator/denominator aggregation', () => {
    const d: BoardDataset = { id: 'd', name: 'TT', createdAt: 0, columns: [{ name: '点击', type: 'number' }, { name: '展示', type: 'number' }, { name: '点击率', type: 'number' }], rows: [[10, 100, 0], [30, 100, 0]] }
    expect(safeMetricValue(d, d.rows, 2, 'sum')).toBe(20)
  })
})
