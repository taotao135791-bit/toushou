import { describe, expect, it } from 'vitest'
import type { BoardDataset } from '@shared/types'
import { sortedTableRows, tablePage } from './boardTable'

const dataset: BoardDataset = { id: 'synthetic-report', name: 'Daily report', createdAt: 1, columns: [{ name: 'Day', type: 'date' }, { name: 'Count', type: 'number' }], rows: [['2026-11-01', 10], ['2026-11-02', 0], ['2026-11-03', ''], ['2026-11-04', 5], ['2026-11-05', 5]] }

describe('daily table sorting and pagination', () => {
  it('sorts actual numeric values, preserves zero and stable equal rows, and leaves missing values last', () => {
    expect(sortedTableRows(dataset, 'Count', 'asc').map(row => row[1])).toEqual([0, 5, 5, 10, ''])
    expect(sortedTableRows(dataset, 'Count', 'desc').map(row => row[1])).toEqual([10, 5, 5, 0, ''])
    expect(sortedTableRows(dataset, 'Count', 'desc').filter(row => row[1] === 5).map(row => row[0])).toEqual(['2026-11-04', '2026-11-05'])
    expect(dataset.rows[0][1]).toBe(10)
  })

  it('paginates without dropping rows and clamps a page after the date range becomes smaller', () => {
    const rows = Array.from({ length: 12 }, (_value, index) => [index])
    expect(tablePage(rows, 1, 5)).toMatchObject({ rows: [[5], [6], [7], [8], [9]], page: 1, pages: 3, start: 6, end: 10 })
    expect(tablePage(rows.slice(0, 2), 2, 5)).toMatchObject({ rows: [[0], [1]], page: 0, pages: 1, start: 1, end: 2 })
    expect(tablePage([], 9, 5)).toMatchObject({ rows: [], page: 0, pages: 1, start: 0, end: 0 })
  })
})
