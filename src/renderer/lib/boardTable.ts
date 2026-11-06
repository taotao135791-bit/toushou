import type { BoardDataset } from '@shared/types'

/** Stable sorting leaves missing values at the end without coercing them to zero. */
export function sortedTableRows(dataset: BoardDataset, columnName: string, direction: 'asc' | 'desc'): (string | number)[][] {
  const index = dataset.columns.findIndex(column => column.name === columnName)
  if (index < 0) return dataset.rows
  const numeric = dataset.columns[index].type === 'number'
  return dataset.rows.map((row, order) => ({ row, order })).sort((a, b) => {
    const left = a.row[index], right = b.row[index]
    const missingLeft = left === '' || left === undefined, missingRight = right === '' || right === undefined
    if (missingLeft !== missingRight) return missingLeft ? 1 : -1
    if (missingLeft) return a.order - b.order
    const delta = numeric && typeof left === 'number' && typeof right === 'number'
      ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })
    return (direction === 'asc' ? delta : -delta) || a.order - b.order
  }).map(item => item.row)
}

export function tablePage(rows: (string | number)[][], page: number, pageSize: number): { rows: (string | number)[][]; page: number; pages: number; start: number; end: number } {
  const size = Number.isSafeInteger(pageSize) ? Math.min(100, Math.max(5, pageSize)) : 20
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const boundedPage = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0))
  return { rows: rows.slice(boundedPage * size, (boundedPage + 1) * size), page: boundedPage, pages, start: rows.length ? boundedPage * size + 1 : 0, end: Math.min(rows.length, (boundedPage + 1) * size) }
}
