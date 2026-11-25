import { type BoardWidget, type KanbanBoard } from '@shared/types'
import { useT } from '../i18n'
import { widgetCardStyle } from '../pages/boards/widgetCardStyle'

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []

function savedDetail(widget: BoardWidget, zh: boolean): string {
  const config = widget.config
  if (widget.type === 'funnel' && Array.isArray(config.stages)) return strings(config.stages.map(stage => stage?.label)).join(' → ')
  if (config.source === 'dataset') {
    const columns = strings(config.columns)
    const fields = columns.length ? columns : [config.metric, config.dimension].filter(Boolean)
    return fields.length ? fields.join(' · ') : (zh ? '打开看板查看数据' : 'Open board for data')
  }
  switch (widget.type) {
    case 'note': return typeof config.text === 'string' ? config.text.slice(0, 240) : ''
    case 'counter':
    case 'gauge':
      return [typeof config.value === 'number' ? `${config.value.toLocaleString(zh ? 'zh-CN' : 'en-US')}${widget.type === 'gauge' ? '%' : ''}` : '—', config.label].filter(Boolean).join(' ')
    case 'chart-bar':
    case 'chart-line':
      if (!Array.isArray(config.points)) return ''
      return config.points.slice(0, 8).map((point, i) => {
        const label = Array.isArray(config.labels) && config.labels[i] ? config.labels[i] + ' ' : ''
        return label + (typeof point === 'number' ? point : point?.value) + (point?.forecast ? (zh ? '（预测）' : ' (forecast)') : '')
      }).join(' · ')
    case 'todo':
      return Array.isArray(config.items) ? config.items.slice(0, 3).map(item => `${item.done ? '☑' : '☐'} ${item.text}`).join('  ') : ''
    case 'link':
      if (typeof config.url === 'string') { try { return new URL(config.url).host } catch { return '' } }
      return ''
    case 'file':
      return typeof config.filePath === 'string' ? config.filePath.split(/[\\/]/).pop() || '' : ''
    default:
      return strings(config.metrics).join(' · ')
  }
}

/** Read-only projection. A binding can describe its saved columns, but displaying a
 * live value belongs to the board's permission- and date-scoped refresh pipeline. */
export default function SavedBoardLayout({ board, zh }: { board: KanbanBoard; zh: boolean }) {
  const t = useT()
  if (!board.widgets.length) return <p className="px-4 pb-3 text-[12px] text-cream-faint">{zh ? '看板中还没有模块' : 'This board has no modules yet.'}</p>

  // Use saved grid boundaries. Bounded gaps keep older, sparse layouts affordable.
  const rows = [...new Set(board.widgets.flatMap(({ layout }) => [layout.y, layout.y + layout.h]))].sort((a, b) => a - b)
  const rowIndex = new Map(rows.map((y, i) => [y, i + 1]))
  return <div role="group" aria-label={zh ? '已保存的看板布局' : 'Saved board layout'} className="max-h-72 overflow-auto border-t border-line bg-ink-900 p-2.5" style={{ backgroundColor: board.style?.background }}>
    <div className="grid grid-cols-12 gap-x-1.5" style={{ gridTemplateRows: rows.slice(1).map((y, i) => `${Math.min(9, y - rows[i]) * 18}px`).join(' ') }}>
      {board.widgets.map(widget => {
        const { x, y, w, h } = widget.layout
        const typeName = t(`boards.widget.${widget.type}`)
        const detail = savedDetail(widget, zh)
        return <div key={widget.id} className="my-0.5 min-w-0 overflow-hidden rounded-md border border-line bg-ink-850 px-2 py-1 text-[11px] leading-tight" style={{
          ...widgetCardStyle(widget.style), gridColumn: `${x + 1} / span ${w}`, gridRow: `${rowIndex.get(y)} / ${rowIndex.get(y + h)}`,
          borderColor: widget.style?.border, borderRadius: Math.min(9, widget.style?.radius ?? 7), boxShadow: 'none'
        }}>
          <p className="truncate font-semibold text-cream" title={widget.title} style={{ textAlign: widget.style?.titleAlign }}>{widget.title || typeName}</p>
          <p className="mt-0.5 line-clamp-3 break-words text-cream-dim">{detail || (widget.title !== typeName ? typeName : '')}</p>
        </div>
      })}
    </div>
  </div>
}
