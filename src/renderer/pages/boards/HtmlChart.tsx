import { useEffect, useRef, useState } from 'react'

export interface HtmlChartPoint { value: number; forecast: boolean; lo: number | null; hi: number | null }

export function chartScale(points: HtmlChartPoint[], bar: boolean) {
  const bounds = points.flatMap(p => bar ? [p.value] : [p.value, p.lo ?? p.value, p.hi ?? p.value])
  let min = Math.min(...bounds)
  let max = Math.max(...bounds)
  if (bar) { min = Math.min(0, min); max = Math.max(0, max) }
  if (min === max) { if (bar) max = min + 1; else { min -= 0.5; max += 0.5 } }
  return { min, max, y: (value: number) => 100 - (value - min) / (max - min) * 100 }
}

const format = (n: number) => Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n * 100) / 100}`

/** HTML marks and CSS segments, with an equivalent table for keyboard and screen readers. */
export function HtmlChart({ points, labels, bar, title, scope, currency, forecastLabel, showValues }: {
  points: HtmlChartPoint[]; labels: string[]; bar: boolean; title: string; scope: string | null
  currency: string | null; forecastLabel: string; showValues: boolean
}) {
  const plot = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 280, height: 100 })
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    if (!plot.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(plot.current)
    return () => observer.disconnect()
  }, [])
  const { min, max, y } = chartScale(points, bar)
  const x = (i: number) => bar ? (i + 0.5) / points.length * 100 : points.length === 1 ? 50 : i / (points.length - 1) * 100
  const chosen = selected === null ? null : points[Math.min(points.length - 1, selected)]
  const selectedIndex = selected === null ? 0 : Math.min(points.length - 1, selected)
  const pointLabel = (i: number) => `${labels[i] ?? `#${i + 1}`}: ${points[i].value.toLocaleString()}${points[i].forecast ? ` (${forecastLabel})` : ''}`
  const labelStep = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(size.width / 65))))
  return <div className="flex h-full min-h-0 flex-col gap-1 text-[11px]">
    <div className="flex flex-wrap justify-between gap-x-2 text-cream-faint"><span>{scope}</span><span>{currency}</span></div>
    <div className="relative min-h-[90px] flex-1 pb-5 pl-9 pr-3 pt-3" role="group" aria-label={title}>
      <div ref={plot} className="relative h-full min-h-[60px]" tabIndex={0} role="img"
        aria-label={`${title}. ${pointLabel(selectedIndex)}. ← →`}
        onFocus={() => setSelected(selectedIndex)} onBlur={() => setSelected(null)}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, selectedIndex + (event.key === 'ArrowRight' ? 1 : -1))))
        } }}
        onMouseMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))); setSelected(Math.min(points.length - 1, bar ? Math.floor(fraction * points.length) : Math.round(fraction * (points.length - 1)))) }}
        onMouseLeave={() => { if (document.activeElement !== plot.current) setSelected(null) }}>
        {[min, (min + max) / 2, max].map(value => <div key={value} className="pointer-events-none absolute w-full border-t border-line" style={{ top: `${y(value)}%` }} aria-hidden="true"><span className="absolute -left-9 -top-2 w-8 text-right text-cream-faint">{format(value)}</span></div>)}
        {bar && min < 0 && max > 0 && <div className="pointer-events-none absolute w-full border-t border-cream-faint" style={{ top: `${y(0)}%` }} />}
        {!bar && points.slice(1).map((point, index) => {
          const prior = points[index]
          const dx = (x(index + 1) - x(index)) * size.width / 100
          const dy = (y(point.value) - y(prior.value)) * size.height / 100
          const forecast = point.forecast || prior.forecast
          return <span key={index} aria-hidden="true" className="pointer-events-none absolute origin-left border-t-2" style={{ left: `${x(index)}%`, top: `${y(prior.value)}%`, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)`, borderColor: 'var(--board-widget-accent)', borderStyle: forecast ? 'dashed' : 'solid', opacity: forecast ? 0.6 : 1 }} />
        })}
        {points.map((point, i) => <div key={i} aria-hidden="true">
          {!bar && point.forecast && point.lo !== null && point.hi !== null && <span className="pointer-events-none absolute border-x border-dashed" style={{ left: `${x(i)}%`, top: `${y(point.hi)}%`, height: `${Math.abs(y(point.lo) - y(point.hi))}%`, width: 8, transform: 'translateX(-50%)', background: 'var(--board-widget-accent)', opacity: 0.15 }} />}
          <span className="pointer-events-none absolute" style={bar ? { left: `${x(i)}%`, top: `${Math.min(y(point.value), y(0))}%`, width: `${Math.min(10, 62 / points.length)}%`, height: `${Math.abs(y(point.value) - y(0))}%`, transform: 'translateX(-50%)', background: 'var(--board-widget-accent)', opacity: point.forecast ? 0.4 : 0.85, border: point.forecast ? '1px dashed currentColor' : undefined } : { left: `${x(i)}%`, top: `${y(point.value)}%`, width: 6, height: 6, borderRadius: '50%', transform: 'translate(-50%,-50%)', background: point.forecast ? 'var(--board-widget-surface)' : 'var(--board-widget-accent)', border: '1px solid var(--board-widget-accent)' }} />
          {showValues && size.width / points.length >= 28 && <span className="pointer-events-none absolute -translate-x-1/2 text-cream-faint" style={{ left: `${x(i)}%`, top: `${y(point.value)}%`, transform: `translate(-50%, ${point.value < 0 && bar ? '2px' : '-100%'})` }}>{format(point.value)}</span>}
          {i % labelStep === 0 && <span className="pointer-events-none absolute top-full mt-1 max-w-[65px] truncate text-cream-faint" style={{ left: `${x(i)}%`, transform: `translateX(${i === 0 ? '0' : i === points.length - 1 ? '-100%' : '-50%'})` }}>{labels[i] ?? `#${i + 1}`}</span>}
        </div>)}
      </div>
      {chosen && <div role="status" className="pointer-events-none absolute bottom-6 left-10 right-4 rounded border border-line bg-ink-900 px-2 py-1 text-cream">{pointLabel(selectedIndex)}{chosen.forecast && chosen.lo !== null && chosen.hi !== null ? ` [${chosen.lo.toLocaleString()} – ${chosen.hi.toLocaleString()}]` : ''}</div>}
    </div>
    <details className="shrink-0 text-cream-faint"><summary className="cursor-pointer">{title} · {points.length}</summary><div className="max-h-32 overflow-auto"><table className="w-full text-left"><caption className="sr-only">{title} {currency} {scope}</caption><thead><tr><th scope="col">#</th><th scope="col">{title}</th><th scope="col">{forecastLabel}</th><th scope="col">Min – Max</th></tr></thead><tbody>{points.map((point, i) => <tr key={i}><th scope="row">{labels[i] ?? i + 1}</th><td>{point.value.toLocaleString()}</td><td>{point.forecast ? forecastLabel : '—'}</td><td>{point.lo === null || point.hi === null ? '—' : `${point.lo} – ${point.hi}`}</td></tr>)}</tbody></table></div></details>
  </div>
}
