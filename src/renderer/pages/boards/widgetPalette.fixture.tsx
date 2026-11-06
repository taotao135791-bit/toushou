import { createRoot } from 'react-dom/client'
import { WidgetBody } from './WidgetBody'
import { widgetCardStyle } from './widgetCardStyle'
import { useAppStore } from '../../store'
import type { BoardDataset, BoardWidget, BoardWidgetStyle } from '@shared/types'

useAppStore.setState({ language: 'en' })
Object.assign(window, { electronAPI: { fxRatesGet: async () => null } })
const dataset: BoardDataset = { id: 'synthetic-data', name: 'Synthetic report', createdAt: 1, columns: [{ name: 'Count', type: 'number' }], rows: [[12]] }
const palettes: Record<string, BoardWidgetStyle | undefined> = {
  default: undefined,
  navy: { surface: '#132435', text: '#e8f2fc', accent: '#20a080', border: '#405060' },
  paper: { surface: '#f4eadf', text: '#243444', accent: '#c05030', border: '#b0a090' },
  automatic: { surface: '#777777' }
}
const widgets: BoardWidget[] = [
  { id: 'counter', type: 'counter', title: 'Count', layout: { x: 0, y: 0, w: 3, h: 3 }, config: { source: 'dataset', datasetId: dataset.id, metric: 'Count', op: 'sum' } },
  { id: 'note', type: 'note', title: 'Summary', layout: { x: 0, y: 0, w: 3, h: 3 }, config: { text: 'Current summary' } },
  { id: 'table', type: 'table', title: 'Daily table', layout: { x: 0, y: 0, w: 6, h: 4 }, config: { source: 'dataset', datasetId: dataset.id, columns: ['Count'], pageSize: 5 } },
  { id: 'funnel', type: 'funnel', title: 'Path', layout: { x: 0, y: 0, w: 6, h: 4 }, config: { source: 'dataset', stages: [{ label: 'First', datasetId: dataset.id, metric: 'Count', op: 'sum' }, { label: 'Next', datasetId: dataset.id, metric: 'Count', op: 'sum' }] } }
]
createRoot(document.getElementById('root')!).render(<main className="p-4">
  {Object.entries(palettes).map(([name, palette]) => <section key={name} data-palette={name} className="mb-4 grid grid-cols-4 gap-3">
    {widgets.map(widget => <article key={widget.id} data-kind={widget.id} className="board-widget h-56 overflow-hidden rounded-xl border border-line bg-ink-850 p-3" style={widgetCardStyle(palette)}>
      <h2 className="mb-2 text-cream-dim">{widget.title}</h2>
      <div className="h-40"><WidgetBody widget={widget} boardId="synthetic-board" datasets={[dataset]} onConfigChange={() => {}} /></div>
      {widget.type === 'note' && <p data-status className="text-red-500">Source failed</p>}
    </article>)}
  </section>)}
</main>)
