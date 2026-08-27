import { describe, it, expect } from 'vitest'
import { BoardDataset } from '../types'
import {
  DATASET_LIMITS,
  GROUP_TOP_N,
  aggregate,
  buildDataset,
  cleanNumberString,
  columnIndex,
  groupAggregate,
  inferColumnType,
  parseDateString,
  validateDataset
} from '../datasets'

describe('cleanNumberString', () => {
  it('cleans plain numbers', () => {
    expect(cleanNumberString('100')).toBe(100)
    expect(cleanNumberString('-5.5')).toBe(-5.5)
    expect(cleanNumberString(' 42 ')).toBe(42)
  })

  it('cleans thousands separators', () => {
    expect(cleanNumberString('1,234.56')).toBe(1234.56)
    expect(cleanNumberString('1,234,567')).toBe(1234567)
  })

  it('cleans percent and currency decorations', () => {
    expect(cleanNumberString('12%')).toBe(12)
    expect(cleanNumberString('12.5 %')).toBe(12.5)
    expect(cleanNumberString('$100')).toBe(100)
    expect(cleanNumberString('$ 1,000.5')).toBe(1000.5)
    expect(cleanNumberString('¥100')).toBe(100)
    expect(cleanNumberString('￥200')).toBe(200)
  })

  it('treats parentheses as negative', () => {
    expect(cleanNumberString('(100)')).toBe(-100)
    expect(cleanNumberString('(1,234.56)')).toBe(-1234.56)
  })

  it('rejects non-numeric and empty input', () => {
    expect(cleanNumberString('')).toBeNull()
    expect(cleanNumberString('   ')).toBeNull()
    expect(cleanNumberString('abc')).toBeNull()
    expect(cleanNumberString('12abc')).toBeNull()
    expect(cleanNumberString('1.2.3')).toBeNull()
  })
})

describe('parseDateString', () => {
  it('normalizes ISO-ish shapes to YYYY-MM-DD', () => {
    expect(parseDateString('2024-01-01')).toBe('2024-01-01')
    expect(parseDateString('2024/1/5')).toBe('2024-01-05')
    expect(parseDateString('2024.1.5')).toBe('2024-01-05')
    expect(parseDateString('2024年1月5日')).toBe('2024-01-05')
    expect(parseDateString('20240105')).toBe('2024-01-05')
  })

  it('prefers US m/d/yyyy and swaps when the first number exceeds 12', () => {
    expect(parseDateString('01/02/2024')).toBe('2024-01-02')
    expect(parseDateString('13/01/2024')).toBe('2024-01-13')
    expect(parseDateString('12/31/2024')).toBe('2024-12-31')
  })

  it('rejects non-dates', () => {
    expect(parseDateString('')).toBeNull()
    expect(parseDateString('hello')).toBeNull()
    expect(parseDateString('2024/13')).toBeNull()
    expect(parseDateString('00/00/2024')).toBeNull()
  })
})

describe('inferColumnType', () => {
  it('infers number at the 80% threshold', () => {
    expect(inferColumnType(['1', '2', '3', '4', 'x'])).toBe('number')
    expect(inferColumnType(['1', '2', '3', 'x', 'y'])).toBe('text')
  })

  it('infers date before number (20240105 is a date, not a number)', () => {
    expect(inferColumnType(['20240105', '2024-01-06', '01/07/2024'])).toBe('date')
  })

  it('falls back to text and treats empty samples as text', () => {
    expect(inferColumnType(['Google', 'Meta'])).toBe('text')
    expect(inferColumnType(['', '  '])).toBe('text')
  })
})

describe('buildDataset', () => {
  it('infers types and cleans values into typed rows', () => {
    const built = buildDataset(
      ['日期', '渠道', '消耗', 'CTR'],
      [
        ['2024-01-01', 'Google', '$1,234.56', '12%'],
        ['2024-01-02', 'Meta', '(100)', '13%'],
        ['', '', '', '']
      ])
    expect(built.columns).toEqual([
      { name: '日期', type: 'date' },
      { name: '渠道', type: 'text' },
      { name: '消耗', type: 'number' },
      { name: 'CTR', type: 'number' }
    ])
    expect(built.rows).toEqual([
      ['2024-01-01', 'Google', 1234.56, 12],
      ['2024-01-02', 'Meta', -100, 13]
    ])
    // The all-empty third row is dropped.
    expect(built.truncated).toBe(false)
  })

  it('stores an empty string for values that fail cleaning in a number column', () => {
    const built = buildDataset(['n'], [['1'], ['2'], ['3'], ['4'], ['bad']])
    expect(built.columns).toEqual([{ name: 'n', type: 'number' }])
    expect(built.rows).toEqual([[1], [2], [3], [4], ['']])
  })

  it('drops fully empty columns (blank header AND blank values)', () => {
    const built = buildDataset(['a', '', 'b'], [['1', '', '2'], ['3', '', '4']])
    expect(built.columns.map((c) => c.name)).toEqual(['a', 'b'])
    // Surviving columns are still type-inferred (both numeric here).
    expect(built.rows).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  it('keeps columns that have a header but no values', () => {
    const built = buildDataset(['a', 'b'], [['1', ''], ['2', '']])
    expect(built.columns).toHaveLength(2)
  })

  it('names blank headers and deduplicates duplicate names', () => {
    const built = buildDataset(['消耗', '消耗', ''], [['1', '2', 'x']])
    expect(built.columns.map((c) => c.name)).toEqual(['消耗', '消耗 (2)', 'col_3'])
  })

  it('truncates columns and rows at the limits and flags it', () => {
    const wideHeaders = Array.from({ length: DATASET_LIMITS.maxColumns + 5 }, (_, i) => `c${i}`)
    const wide = buildDataset(wideHeaders, [wideHeaders.map(() => '1')])
    expect(wide.columns).toHaveLength(DATASET_LIMITS.maxColumns)
    expect(wide.truncated).toBe(true)

    const tallRows = Array.from({ length: DATASET_LIMITS.maxRows + 3 }, () => ['1'])
    const tall = buildDataset(['n'], tallRows)
    expect(tall.rows).toHaveLength(DATASET_LIMITS.maxRows)
    expect(tall.truncated).toBe(true)
  })
})

describe('aggregate', () => {
  const values: (string | number)[] = [1, 2, 3, '', 'x', 4]

  it('computes each op over numbers only', () => {
    expect(aggregate(values, 'sum')).toBe(10)
    expect(aggregate(values, 'avg')).toBe(2.5)
    expect(aggregate(values, 'max')).toBe(4)
    expect(aggregate(values, 'min')).toBe(1)
  })

  it('count counts present (non-empty) cells, numbers or not', () => {
    expect(aggregate(values, 'count')).toBe(5)
    expect(aggregate(['', ''], 'count')).toBe(0)
  })

  it('returns 0 for empty numeric input', () => {
    expect(aggregate([], 'sum')).toBe(0)
    expect(aggregate(['', 'x'], 'avg')).toBe(0)
  })
})

describe('groupAggregate', () => {
  function makeDataset(rows: (string | number)[][]): BoardDataset {
    return {
      id: 'ds',
      name: 'ds',
      columns: [
        { name: '渠道', type: 'text' },
        { name: '消耗', type: 'number' }
      ],
      rows,
      createdAt: 1
    }
  }

  it('groups by dimension and orders by aggregated value desc', () => {
    const ds = makeDataset([
      ['Google', 10],
      ['Meta', 20],
      ['Google', 5],
      ['TikTok', 8]
    ])
    expect(groupAggregate(ds, 0, 1, 'sum')).toEqual({
      labels: ['Meta', 'Google', 'TikTok'],
      points: [20, 15, 8]
    })
  })

  it('folds everything beyond Top-N into one "other" bucket', () => {
    const rows: (string | number)[][] = Array.from(
      { length: GROUP_TOP_N + 5 },
      (_, i) => [`ch${String(i).padStart(2, '0')}`, i + 1]
    )
    const ds = makeDataset(rows)
    const grouped = groupAggregate(ds, 0, 1, 'sum', '其他')
    expect(grouped.labels).toHaveLength(GROUP_TOP_N + 1)
    expect(grouped.labels[GROUP_TOP_N]).toBe('其他')
    // Top values are N+5 .. 6; the rest (5..1) fold into other = 15.
    expect(grouped.points[0]).toBe(GROUP_TOP_N + 5)
    expect(grouped.points[GROUP_TOP_N]).toBe(1 + 2 + 3 + 4 + 5)
  })

  it('sorts date dimensions chronologically', () => {
    const ds: BoardDataset = {
      id: 'ds',
      name: 'ds',
      columns: [
        { name: '日期', type: 'date' },
        { name: '消耗', type: 'number' }
      ],
      rows: [
        ['2024-01-03', 3],
        ['2024-01-01', 1],
        ['2024-01-02', 2],
        ['2024-01-01', 10]
      ],
      createdAt: 1
    }
    expect(groupAggregate(ds, 0, 1, 'sum')).toEqual({
      labels: ['2024-01-01', '2024-01-02', '2024-01-03'],
      points: [11, 2, 3]
    })
  })

  it('buckets empty dimension values together', () => {
    const ds = makeDataset([
      ['', 1],
      ['Google', 2],
      ['', 3]
    ])
    const grouped = groupAggregate(ds, 0, 1, 'sum')
    expect(grouped.labels).toContain('(empty)')
    expect(grouped.points[grouped.labels.indexOf('(empty)')]).toBe(4)
  })
})

describe('columnIndex', () => {
  it('finds columns by name and returns -1 when absent', () => {
    const ds: BoardDataset = {
      id: 'ds',
      name: 'ds',
      columns: [{ name: 'a', type: 'number' }],
      rows: [],
      createdAt: 1
    }
    expect(columnIndex(ds, 'a')).toBe(0)
    expect(columnIndex(ds, 'b')).toBe(-1)
  })
})

describe('validateDataset', () => {
  function valid(): BoardDataset {
    return {
      id: 'ds-1',
      name: 'Report',
      columns: [
        { name: '日期', type: 'date' },
        { name: '消耗', type: 'number' }
      ],
      rows: [
        ['2024-01-01', 100],
        ['2024-01-02', '']
      ],
      createdAt: 1000
    }
  }

  it('accepts a well-formed dataset', () => {
    expect(validateDataset(valid())).toEqual(valid())
  })

  it('rejects non-objects and bad scalar fields', () => {
    expect(validateDataset(null)).toBeNull()
    expect(validateDataset('ds')).toBeNull()
    expect(validateDataset({ ...valid(), id: '' })).toBeNull()
    expect(validateDataset({ ...valid(), id: 'x\ny' })).toBeNull()
    expect(validateDataset({ ...valid(), name: '  ' })).toBeNull()
    expect(validateDataset({ ...valid(), name: 'x'.repeat(201) })).toBeNull()
    expect(validateDataset({ ...valid(), createdAt: Number.NaN })).toBeNull()
  })

  it('rejects bad columns, duplicate names and over-limit shapes', () => {
    expect(validateDataset({ ...valid(), columns: [{ name: 'a', type: 'json' }] })).toBeNull()
    expect(
      validateDataset({
        ...valid(),
        columns: [
          { name: 'a', type: 'text' },
          { name: 'a', type: 'text' }
        ]
      })
    ).toBeNull()
    const wide = Array.from({ length: DATASET_LIMITS.maxColumns + 1 }, (_, i) => ({
      name: `c${i}`,
      type: 'text' as const
    }))
    expect(validateDataset({ ...valid(), columns: wide })).toBeNull()
  })

  it('rejects rows with wrong cell types or too many rows', () => {
    expect(validateDataset({ ...valid(), rows: [[null]] })).toBeNull()
    expect(validateDataset({ ...valid(), rows: [[Number.NaN]] })).toBeNull()
    expect(validateDataset({ ...valid(), rows: 'x' })).toBeNull()
    const tall = Array.from({ length: DATASET_LIMITS.maxRows + 1 }, () => ['x'])
    expect(validateDataset({ ...valid(), rows: tall })).toBeNull()
  })
})
