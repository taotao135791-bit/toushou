import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import type { BoardDataset, BoardWidget } from '@shared/types'
import { sortedTableRows, tablePage } from '../../lib/boardTable'
import { useT } from '../../i18n'

export function DatasetTableBody({ widget, dataset, scope, loading = false }: { widget: BoardWidget; dataset: BoardDataset; scope: string | null; loading?: boolean }) {
  const t = useT()
  const [sortColumn, setSortColumn] = useState(typeof widget.config.sortColumn === 'string' ? widget.config.sortColumn : '')
  const [direction, setDirection] = useState<'asc' | 'desc'>(widget.config.sortDirection === 'desc' ? 'desc' : 'asc')
  const [page, setPage] = useState(0)
  useEffect(() => {
    setSortColumn(typeof widget.config.sortColumn === 'string' ? widget.config.sortColumn : '')
    setDirection(widget.config.sortDirection === 'desc' ? 'desc' : 'asc')
    setPage(0)
  }, [widget.config.sortColumn, widget.config.sortDirection, widget.config.datasetId, scope])
  const chosen = Array.isArray(widget.config.columns) ? widget.config.columns as string[] : dataset.columns.slice(0, 8).map(column => column.name)
  const indices = chosen.map(name => dataset.columns.findIndex(column => column.name === name))
  if (!indices.length || indices.some(index => index < 0)) return <p role="status" className="flex h-full items-center justify-center text-[12px] text-cream-faint">{t('boards.datasets.columnMissing')}</p>
  const unavailable = dataset.appsflyer?.status === 'failed' || dataset.appsflyer?.status === 'unbound'
  const visible = unavailable ? { ...dataset, rows: [] } : dataset
  const result = tablePage(sortedTableRows(visible, sortColumn, direction), page, typeof widget.config.pageSize === 'number' ? widget.config.pageSize : 20)
  const sort = (name: string) => {
    setDirection(current => sortColumn === name && current === 'asc' ? 'desc' : 'asc')
    setSortColumn(name)
    setPage(0)
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="mb-2 truncate text-[10px] text-cream-faint" title={[dataset.name, scope].filter(Boolean).join(' · ')}>{[dataset.name, scope].filter(Boolean).join(' · ')}</div>
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line">
      <table aria-label={widget.title} className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-ink-850"><tr>{indices.map(index => {
          const column = dataset.columns[index], active = sortColumn === column.name
          return <th key={column.name} scope="col" aria-sort={active ? direction === 'asc' ? 'ascending' : 'descending' : 'none'} className={`border-b border-line px-3 py-2 font-medium text-cream-dim ${column.type === 'number' ? 'text-right' : 'text-left'}`}>
            <button type="button" onClick={() => sort(column.name)} className={`focus-ring inline-flex max-w-full items-center gap-1 rounded text-inherit ${column.type === 'number' ? 'ml-auto' : ''}`}><span className="whitespace-nowrap">{column.name}</span>{active && (direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>
          </th>
        })}</tr></thead>
        <tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-line last:border-0 hover:bg-overlay">{indices.map(index => {
          const value = row[index], numeric = dataset.columns[index].type === 'number', date = dataset.columns[index].type === 'date'
          return <td key={index} className={`max-w-[280px] px-3 py-2 align-top tabular-nums text-cream ${numeric ? 'whitespace-nowrap text-right' : date ? 'whitespace-nowrap' : 'break-words'}`}>{value === '' || value === undefined ? <span className="text-cream-faint">—</span> : numeric && typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(value)}</td>
        })}</tr>)}</tbody>
      </table>
      {!result.rows.length && <div role="status" className="px-3 py-8 text-center text-[12px] text-cream-faint">{loading ? t('boards.data.updating') : dataset.appsflyer?.status === 'failed' ? t('boards.data.failed') : dataset.appsflyer?.status === 'unbound' ? t('boards.funnel.unbound') : t('boards.data.empty')}</div>}
    </div>
    <div className="mt-2 flex shrink-0 items-center justify-between gap-2 text-[11px] tabular-nums text-cream-faint">
      <span>{t('boards.table.rows', { start: String(result.start), end: String(result.end), total: String(visible.rows.length) })}</span>
      <div className="flex items-center gap-2"><button type="button" aria-label={t('boards.table.previous')} disabled={result.page === 0} onClick={() => setPage(result.page - 1)} className="focus-ring rounded-md border border-line p-1 text-cream-dim hover:bg-overlay disabled:opacity-35"><ChevronLeft size={13} /></button><span>{result.page + 1} / {result.pages}</span><button type="button" aria-label={t('boards.table.next')} disabled={result.page + 1 >= result.pages} onClick={() => setPage(result.page + 1)} className="focus-ring rounded-md border border-line p-1 text-cream-dim hover:bg-overlay disabled:opacity-35"><ChevronRight size={13} /></button></div>
    </div>
  </div>
}
