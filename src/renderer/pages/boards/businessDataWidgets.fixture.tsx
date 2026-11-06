import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { WidgetBody } from './WidgetBody'
import { useAppStore } from '../../store'
import type { BoardDataset, BoardWidget } from '@shared/types'

useAppStore.setState({ language: 'en' })
Object.assign(window, { electronAPI: { fxRatesGet: async () => null } })
const widgets: BoardWidget[] = [
  { id: 'daily-table', type: 'table', title: 'Daily report', layout: { x: 0, y: 0, w: 12, h: 7 }, config: { source: 'dataset', datasetId: 'media-daily', columns: ['Date', 'Count'], pageSize: 5, sortColumn: 'Count', sortDirection: 'asc' } },
  { id: 'business-funnel', type: 'funnel', title: 'Business path', layout: { x: 0, y: 7, w: 8, h: 5 }, config: { source: 'dataset', stages: [
    { source: 'dataset', label: 'Trial', datasetId: 'third-party-trials', metric: 'Count', op: 'sum' },
    { source: 'dataset', label: 'Reach', datasetId: 'media-daily', metric: 'Count', op: 'sum' },
    { source: 'dataset', label: 'Completed', datasetId: 'third-party-complete', metric: 'Count', op: 'sum' }
  ] } }
]

function Fixture() {
  const [day, setDay] = useState('2026-11-01')
  const [fresh, setFresh] = useState(false)
  const [failed, setFailed] = useState(false)
  const failedState: BoardDataset['appsflyer'] = failed ? { specId: 'synthetic-query', status: 'failed', window: { start: day, end: day }, dataWindow: { start: day, end: day }, attemptedAt: 2, error: 'synthetic failure' } : undefined
  const columns: BoardDataset['columns'] = [{ name: 'Date', type: 'date' }, { name: 'Count', type: 'number' }]
  const datasets: BoardDataset[] = [
    { id: 'media-daily', name: 'Media report', columns, rows: [...Array.from({ length: 12 }, (_value, index) => ['2026-11-01', index]), ['2026-11-02', 999]], createdAt: 1, ...(failedState ? { appsflyer: failedState } : {}) },
    { id: 'third-party-trials', name: 'Attribution report', columns, rows: [['2026-11-01', 15], ['2026-11-02', fresh ? 4 : 3]], createdAt: 1, ...(failedState ? { appsflyer: failedState } : {}) },
    { id: 'third-party-complete', name: 'Completed report', columns, rows: [], createdAt: 1 }
  ]
  return <div>
    <button id="day-2" onClick={() => setDay('2026-11-02')}>Day 2</button>
    <button id="day-empty" onClick={() => { setDay('2026-11-03'); setFailed(false) }}>Empty day</button>
    <button id="new-data" onClick={() => setFresh(true)}>Refresh source</button>
    <button id="fail-source" onClick={() => setFailed(true)}>Failed source</button>
    {widgets.map(widget => <section key={widget.id} {...(widget.type === 'table' ? { 'data-qa-table': true } : { 'data-qa-funnel': true })} style={{ height: 400 }}>
      <WidgetBody widget={widget} boardId="synthetic-board" datasets={datasets} masterWindow={{ start: day, end: day }} onConfigChange={() => {}} />
    </section>)}
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
