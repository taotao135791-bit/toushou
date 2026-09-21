import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, FileWarning, X } from 'lucide-react'
import { FbReadingBody } from './FbReadingBody'
import { FbReadingSummaryBody } from './FbReadingSummaryBody'
import { TTReadingBody } from './TTReadingBody'
import { BoardDataset, BoardWidget } from '@shared/types'
import { BOARD_LIMITS, TodoItem, isValidLinkUrl } from '@shared/boards'
import {
  DATASET_OPS,
  DatasetOp,
  aggregate,
  columnIndex,
  groupAggregate
} from '@shared/datasets'
import { useAppStore } from '../../store'
import { useT } from '../../i18n'

/**
 * Per-type widget bodies for the board grid. All painting is hand-rolled SVG
 * (no chart library); interactive bodies (todo, link) write back through
 * `onConfigChange`, which the page persists immediately as a whole-board
 * upsert. The page remounts bodies (via React key) when the toolbar refresh
 * button is pressed, so live widgets re-render on demand.
 *
 * Counter/line/bar widgets can bind to an imported dataset (config.source ===
 * 'dataset'): the value/labels/points are then computed here from the datasets
 * the page passes down, using the shared aggregation helpers, and rendered by
 * the same code path as manual values. A deleted dataset or renamed column
 * degrades to a small placeholder instead of breaking the board.
 *
 * File widgets load their bound workspace file THROUGH Main (boards:widget-
 * file-read; the renderer never passes a path): images arrive as data URLs,
 * HTML is sandbox-rendered in an iframe with allow-scripts and deliberately
 * WITHOUT allow-same-origin, so embedded scripts run with an opaque origin
 * and no access to app storage. boards:file-changed bumps a reload counter —
 * fresh reads return fresh bytes, which is the cache-busting mechanism.
 */

export interface WidgetBodyProps {
  widget: BoardWidget
  datasets: BoardDataset[]
  /** Owning board id; file widgets need it to address Main's read channel. */
  boardId: string
  onConfigChange: (config: Record<string, unknown>) => void
}

function configOp(value: unknown): DatasetOp {
  return typeof value === 'string' && (DATASET_OPS as readonly string[]).includes(value)
    ? (value as DatasetOp)
    : 'sum'
}

function configStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Outcome of resolving a widget's dataset binding against the loaded datasets. */
type Binding =
  | { kind: 'ok'; dataset: BoardDataset; metricIndex: number; dimIndex: number }
  | { kind: 'missing-dataset' | 'missing-column' | 'incomplete' }

function resolveBinding(widget: BoardWidget, datasets: BoardDataset[], needsDim: boolean): Binding {
  const datasetId = configStr(widget.config.datasetId)
  const metric = configStr(widget.config.metric)
  const dimension = configStr(widget.config.dimension)
  if (!datasetId || !metric || (needsDim && !dimension)) return { kind: 'incomplete' }
  // Preset templates bind by dataset NAME ("TikTok 报表") — id match first,
  // name fallback so template widgets resolve without knowing generated ids.
  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets.find((d) => d.name === datasetId)
  if (!dataset) return { kind: 'missing-dataset' }
  const metricIndex = columnIndex(dataset, metric)
  const dimIndex = needsDim ? columnIndex(dataset, dimension) : -1
  if (metricIndex < 0 || (needsDim && dimIndex < 0)) return { kind: 'missing-column' }
  return { kind: 'ok', dataset, metricIndex, dimIndex }
}

function BindingPlaceholder({ binding }: { binding: Binding }) {
  const t = useT()
  const text =
    binding.kind === 'missing-dataset'
      ? t('boards.datasets.datasetMissing')
      : binding.kind === 'missing-column'
        ? t('boards.datasets.columnMissing')
        : t('boards.datasets.incomplete')
  return (
    <div className="flex h-full items-center justify-center px-2 text-center text-[11px] text-cream-faint">
      {text}
    </div>
  )
}

function ClockBody({ widget }: { widget: BoardWidget }) {
  const language = useAppStore((s) => s.language)
  const showSeconds = widget.config.showSeconds !== false
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const locale = language === 'zh' ? 'zh-CN' : 'en-US'
  const time = now.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(showSeconds ? { second: '2-digit' as const } : {})
  })
  const date = now.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5">
      <div className="font-mono text-[32px] leading-none tabular-nums tracking-wide text-cream">
        {time}
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-cream-faint">{date}</div>
    </div>
  )
}

function NoteBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const text = typeof widget.config.text === 'string' ? widget.config.text : ''
  if (!text) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-cream-faint">
        {t('boards.noteEmpty')}
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-5 text-cream-dim">
      {text}
    </div>
  )
}

function CounterBody({ widget, datasets }: { widget: BoardWidget; datasets: BoardDataset[] }) {
  const label = typeof widget.config.label === 'string' ? widget.config.label : ''
  let value: number
  if (widget.config.source === 'dataset') {
    const binding = resolveBinding(widget, datasets, false)
    if (binding.kind !== 'ok') return <BindingPlaceholder binding={binding} />
    value = aggregate(
      binding.dataset.rows.map((r) => r[binding.metricIndex] ?? ''),
      configOp(widget.config.op)
    )
  } else {
    value = typeof widget.config.value === 'number' ? widget.config.value : 0
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5">
      <div className="break-all text-center font-mono text-[38px] leading-none tabular-nums text-cream">
        {value.toLocaleString()}
      </div>
      {label && (
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-cream-faint">{label}</div>
      )}
    </div>
  )
}

/** Semicircle gauge: background arc + accent value arc + needle + readout. */
function GaugeBody({ widget }: { widget: BoardWidget }) {
  const raw = typeof widget.config.value === 'number' ? widget.config.value : 0
  const value = Math.min(100, Math.max(0, raw))
  const label = typeof widget.config.label === 'string' ? widget.config.label : ''
  const angle = Math.PI * (1 - value / 100)
  const x = 100 + 80 * Math.cos(angle)
  const y = 100 - 80 * Math.sin(angle)
  const nx = 100 + 54 * Math.cos(angle)
  const ny = 100 - 54 * Math.sin(angle)
  const largeArc = value > 50 ? 1 : 0
  return (
    <div className="flex h-full items-center justify-center">
      <svg viewBox="0 0 200 112" className="max-h-full w-full">
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke="var(--board-widget-border)"
          strokeWidth={10}
          strokeLinecap="round"
        />
        {value > 0 && (
          <path
            d={`M 20 100 A 80 80 0 ${largeArc} 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
            fill="none"
            stroke="var(--board-widget-accent)"
            strokeWidth={10}
            strokeLinecap="round"
          />
        )}
        <line
          x1={100}
          y1={100}
          x2={nx.toFixed(2)}
          y2={ny.toFixed(2)}
          stroke="var(--board-widget-text)"
          strokeWidth={1.5}
        />
        <circle cx={100} cy={100} r={3} fill="var(--board-widget-text)" />
        <text
          x={100}
          y={90}
          textAnchor="middle"
          fontSize={26}
          className="fill-cream font-mono tabular-nums"
        >
          {Math.round(value)}
        </text>
        {label && (
          <text x={100} y={106} textAnchor="middle" fontSize={9} className="fill-cream-faint">
            {label}
          </text>
        )}
      </svg>
    </div>
  )
}

function chartFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`
  return `${Math.round(v * 100) / 100}`
}

/**
 * Chart point shape contract (rendering-side only — nothing upstream is
 * required to emit the extended form yet). A series entry is either a plain
 * number (an observed value) or an object:
 *
 *   { value: number, forecast?: boolean, lo?: number, hi?: number }
 *
 * - `value` — the plotted number, same unit as plain-number points.
 * - `forecast: true` — projection point: the segment leading into it renders
 *   dashed and semi-transparent instead of solid.
 * - `lo` / `hi` — optional confidence-band bounds; when present on forecast
 *   points of a line chart they render as a light band around the line and
 *   widen the y-scale. Bars ignore the band but keep the dashed styling.
 *
 * NOTE: persistence for the extended shape (and for chart `config.showValues`)
 * lives in the per-type config whitelist in `src/shared/boards.ts`; until that
 * whitelist is extended, this renderer tolerates both shapes so the charts
 * already display forecast series fed from any source.
 */
interface ChartPoint {
  value: number
  forecast: boolean
  lo: number | null
  hi: number | null
}

/** Accepts a plain number or the extended { value, forecast?, lo?, hi? } shape. */
function parseChartPoint(raw: unknown): ChartPoint | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: raw, forecast: false, lo: null, hi: null }
  }
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.value !== 'number' || !Number.isFinite(rec.value)) return null
  return {
    value: rec.value,
    forecast: rec.forecast === true,
    lo: typeof rec.lo === 'number' && Number.isFinite(rec.lo) ? rec.lo : null,
    hi: typeof rec.hi === 'number' && Number.isFinite(rec.hi) ? rec.hi : null
  }
}

/** Minimum horizontal slot (svg units) per bar for an always-on value label; below it the label shows on hover only. */
const BAR_LABEL_MIN_SLOT = 28

/** Rough per-character width at the axis font size; CJK glyphs are full-width. */
function approxTextWidth(s: string, fontSize: number): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.56
  return w
}

/** Axis labels are truncated so the skip-interval estimate stays bounded. */
function truncateAxisLabel(s: string): string {
  return s.length > 10 ? `${s.slice(0, 9)}…` : s
}

/**
 * Hand-rolled SVG line/bar chart: gridlines, min/mid/max readouts, always-on
 * (bar) or toggleable (line) value labels, skip-interval x-axis labels, hover
 * crosshair/highlight with an in-widget HTML tooltip, and dashed
 * semi-transparent rendering for `forecast: true` points (with a lo/hi
 * confidence band on line charts).
 */
function ChartBody({
  widget,
  bar,
  datasets
}: {
  widget: BoardWidget
  bar: boolean
  datasets: BoardDataset[]
}) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Hover snapshot in wrapper pixel coordinates (index + tooltip anchor), so
  // the tooltip can be a plain absolutely-positioned div inside the widget
  // instead of a portal.
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  let points: ChartPoint[]
  let labels: string[]
  let dimName = ''
  let metricName = ''
  if (widget.config.source === 'dataset') {
    const binding = resolveBinding(widget, datasets, true)
    if (binding.kind !== 'ok') return <BindingPlaceholder binding={binding} />
    const grouped = groupAggregate(
      binding.dataset,
      binding.dimIndex,
      binding.metricIndex,
      configOp(widget.config.op),
      t('boards.datasets.other')
    )
    points = grouped.points.map(parseChartPoint).filter((p): p is ChartPoint => p !== null)
    labels = grouped.labels
    dimName = binding.dataset.columns[binding.dimIndex]?.name ?? ''
    metricName = binding.dataset.columns[binding.metricIndex]?.name ?? ''
  } else {
    points = Array.isArray(widget.config.points)
      ? (widget.config.points as unknown[])
          .map(parseChartPoint)
          .filter((p): p is ChartPoint => p !== null)
      : []
    labels = Array.isArray(widget.config.labels)
      ? (widget.config.labels as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
  }
  if (points.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-cream-faint">
        {t('boards.chartEmpty')}
      </div>
    )
  }
  const values = points.map((p) => p.value)
  const W = 320
  const H = 120
  const padL = 30
  const padR = 6
  const padT = 14 // headroom for always-on value labels above the tallest mark
  const padB = 16
  const iw = W - padL - padR
  const ih = H - padT - padB
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (!bar) {
    // The confidence band is drawn, so its bounds must fit the scale.
    for (const p of points) {
      if (p.lo !== null) min = Math.min(min, p.lo)
      if (p.hi !== null) max = Math.max(max, p.hi)
    }
  }
  if (min === max) min = max - 1
  const lo = bar ? Math.min(0, min) : min
  const span = max - lo || 1
  const px = (i: number) => padL + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw)
  const py = (v: number) => padT + ih - ((v - lo) / span) * ih
  const gridVals = [lo, lo + span / 2, max]
  const zeroY = py(0)

  // Value labels: on by default for bars (thin bars degrade to hover-only);
  // for lines on when there are at most 12 points. config.showValues wins.
  const showValues =
    typeof widget.config.showValues === 'boolean'
      ? widget.config.showValues
      : bar || points.length <= 12

  // Skip-interval x labeling: estimate the widest (truncated) label and step
  // by however many slots it needs, so every Nth label shows and neighbors
  // never collide — instead of dropping all middle labels.
  const slot = iw / points.length
  const maxLabelW = Math.max(
    0,
    ...labels.slice(0, points.length).map((l) => approxTextWidth(truncateAxisLabel(l), 7.5))
  )
  const labelStep = Math.max(1, Math.ceil((maxLabelW + 4) / slot))

  const tooltipText = (p: ChartPoint): string => {
    const value = p.value.toLocaleString()
    if (dimName && metricName) return `${dimName} ${metricName}: ${value}`
    if (metricName) return `${metricName}: ${value}`
    return value
  }

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // The svg fills the wrapper and letterboxes its viewBox (xMidYMid meet),
    // so convert pointer → viewBox coordinates through the meet transform.
    const scale = Math.min(rect.width / W, rect.height / H) || 1
    const offX = (rect.width - W * scale) / 2
    const offY = (rect.height - H * scale) / 2
    const sx = (e.clientX - rect.left - offX) / scale
    if (sx < padL - 4 || sx > W - padR + 4 || points.length === 0) {
      setHover(null)
      return
    }
    const i = bar
      ? Math.max(0, Math.min(points.length - 1, Math.floor((sx - padL) / slot)))
      : points.reduce(
          (best, _p, idx) => (Math.abs(px(idx) - sx) < Math.abs(px(best) - sx) ? idx : best),
          0
        )
    const p = points[i]
    // Tooltip anchors to the mark itself: bar centers, line points.
    const anchorX = bar ? padL + slot * i + slot / 2 : px(i)
    const anchorY = py(p.value)
    const clampW = Math.max(rect.width, 112)
    setHover({
      i,
      x: Math.min(Math.max(offX + anchorX * scale, 56), clampW - 56),
      y: offY + anchorY * scale
    })
  }

  const hoverPoint = hover && hover.i < points.length ? points[hover.i] : null
  const hoverLabel = hover ? (labels[hover.i] ?? `#${hover.i + 1}`) : ''

  // Forecast split for the line chart: everything up to the last observed
  // point stays solid; the span into the forecast points renders dashed and
  // semi-transparent. With no forecast points this reduces to today's path.
  const lastObserved = points.reduce(
    (last, p, i) => (p.forecast ? last : i),
    -1
  )
  const hasForecast = lastObserved < points.length - 1
  const linePath = (from: number, to: number) =>
    points
      .slice(from, to + 1)
      .map((p, k) => `${k === 0 ? 'M' : 'L'} ${px(from + k).toFixed(2)} ${py(p.value).toFixed(2)}`)
      .join(' ')
  const areaPath = (from: number, to: number) =>
    `${linePath(from, to)} L ${px(to).toFixed(2)} ${py(lo).toFixed(2)} L ${px(from).toFixed(2)} ${py(lo).toFixed(2)} Z`
  // Confidence band: anchored at the last observed point, then every forecast
  // point that carries both lo and hi.
  const bandIndices = hasForecast
    ? [
        Math.max(lastObserved, 0),
        ...points
          .map((p, i) => ({ p, i }))
          .slice(Math.max(lastObserved, 0) + 1)
          .filter(({ p }) => p.forecast && p.lo !== null && p.hi !== null)
          .map(({ i }) => i)
      ]
    : []
  const bandPath =
    bandIndices.length >= 2
      ? `${bandIndices
          .map((i, k) => {
            // The anchor point has no band of its own — pinch to its value.
            const top = points[i].hi ?? points[i].value
            return `${k === 0 ? 'M' : 'L'} ${px(i).toFixed(2)} ${py(top).toFixed(2)}`
          })
          .join(' ')} ${bandIndices
          .slice()
          .reverse()
          .map((i) => {
            const bottom = points[i].lo ?? points[i].value
            return `L ${px(i).toFixed(2)} ${py(bottom).toFixed(2)}`
          })
          .join(' ')} Z`
      : null

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full items-center justify-center"
      onMouseMove={handleMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        {gridVals.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              y1={py(v)}
              x2={W - padR}
              y2={py(v)}
              stroke="var(--board-widget-border)"
              strokeWidth={1}
            />
            <text x={padL - 4} y={py(v) + 2.5} textAnchor="end" fontSize={7.5} className="fill-cream-faint">
              {chartFormat(v)}
            </text>
          </g>
        ))}
        {bar && lo < 0 && (
          <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="var(--board-widget-border)" strokeWidth={1} />
        )}
        {bar ? (
          points.map((p, i) => {
            const bw = Math.min(26, slot * 0.62)
            const bx = padL + slot * i + (slot - bw) / 2
            const top = py(Math.max(p.value, 0))
            const height = Math.max(1, Math.abs(py(p.value) - py(Math.max(lo, 0))))
            const hovered = hover?.i === i
            // Labels need ~28px of slot width to fit between neighbors;
            // thinner slots show the label on hover only.
            const showLabel = slot >= BAR_LABEL_MIN_SLOT || hovered
            const labelY = p.value >= 0 ? top - 3 : py(p.value) + 9
            return (
              <g key={i}>
                <rect
                  x={bx}
                  y={p.value >= 0 ? top : py(Math.max(lo, 0))}
                  width={bw}
                  height={height}
                  rx={1.5}
                  fill="var(--board-widget-accent)"
                  fillOpacity={p.forecast ? 0.35 : hovered ? 1 : 0.8}
                  stroke={p.forecast ? 'var(--board-widget-accent)' : undefined}
                  strokeWidth={p.forecast ? 0.8 : undefined}
                  strokeDasharray={p.forecast ? '2 2' : undefined}
                />
                {showLabel && (
                  <text
                    x={bx + bw / 2}
                    y={labelY}
                    textAnchor="middle"
                    fontSize={7.5}
                    className={hovered ? 'fill-cream font-mono tabular-nums' : 'fill-cream-faint font-mono tabular-nums'}
                  >
                    {chartFormat(p.value)}
                  </text>
                )}
              </g>
            )
          })
        ) : (
          <>
            {hasForecast ? (
              <>
                {lastObserved >= 0 && (
                  <path
                    d={areaPath(0, lastObserved)}
                    fill="var(--board-widget-accent)"
                    fillOpacity={0.1}
                  />
                )}
                <path
                  d={areaPath(Math.max(lastObserved, 0), points.length - 1)}
                  fill="var(--board-widget-accent)"
                  fillOpacity={0.05}
                />
                {bandPath && (
                  <path d={bandPath} fill="var(--board-widget-accent)" fillOpacity={0.12} stroke="none" />
                )}
                {lastObserved >= 0 && (
                  <polyline
                    points={points
                      .slice(0, lastObserved + 1)
                      .map((p, i) => `${px(i).toFixed(2)},${py(p.value).toFixed(2)}`)
                      .join(' ')}
                    fill="none"
                    stroke="var(--board-widget-accent)"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                <polyline
                  points={points
                    .slice(Math.max(lastObserved, 0))
                    .map((p, i) => `${px(Math.max(lastObserved, 0) + i).toFixed(2)},${py(p.value).toFixed(2)}`)
                    .join(' ')}
                  fill="none"
                  stroke="var(--board-widget-accent)"
                  strokeOpacity={0.6}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </>
            ) : (
              <>
                <path
                  d={areaPath(0, points.length - 1)}
                  fill="var(--board-widget-accent)"
                  fillOpacity={0.1}
                />
                <polyline
                  points={points.map((p, i) => `${px(i).toFixed(2)},${py(p.value).toFixed(2)}`).join(' ')}
                  fill="none"
                  stroke="var(--board-widget-accent)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </>
            )}
            {points.length <= 40 &&
              points.map((p, i) =>
                p.forecast ? (
                  <circle
                    key={i}
                    cx={px(i)}
                    cy={py(p.value)}
                    r={1.8}
                    fill="none"
                    stroke="var(--board-widget-accent)"
                    strokeOpacity={0.7}
                    strokeWidth={0.8}
                  />
                ) : (
                  <circle key={i} cx={px(i)} cy={py(p.value)} r={1.6} fill="var(--board-widget-accent)" />
                )
              )}
            {showValues &&
              points.length <= 40 &&
              points.map((p, i) => (
                <text
                  key={i}
                  x={px(i)}
                  y={py(p.value) - 4}
                  textAnchor="middle"
                  fontSize={6.5}
                  className="fill-cream-faint font-mono tabular-nums"
                >
                  {chartFormat(p.value)}
                </text>
              ))}
            {hover && hoverPoint && (
              <>
                <line
                  x1={px(hover.i)}
                  y1={padT}
                  x2={px(hover.i)}
                  y2={padT + ih}
                  stroke="var(--board-widget-border)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <circle
                  cx={px(hover.i)}
                  cy={py(hoverPoint.value)}
                  r={3.2}
                  fill="var(--board-widget-accent)"
                  stroke="var(--board-widget-border)"
                  strokeWidth={1}
                />
              </>
            )}
          </>
        )}
        {labels.slice(0, points.length).map((label, i) =>
          i % labelStep === 0 ? (
            <text
              key={i}
              x={px(i)}
              y={H - 4}
              textAnchor={i === 0 ? (points.length === 1 ? 'middle' : 'start') : i === points.length - 1 ? 'end' : 'middle'}
              fontSize={7.5}
              className="fill-cream-faint"
            >
              {truncateAxisLabel(label)}
            </text>
          ) : null
        )}
      </svg>
      {hover && hoverPoint && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-[190px] rounded-md border border-line bg-ink-900/95 px-2 py-1.5 shadow-xl"
          style={{
            left: hover.x,
            top: hover.y,
            transform:
              hover.y < 48 ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 8px))'
          }}
        >
          <div className="truncate text-[10.5px] font-medium leading-4 text-cream">{hoverLabel}</div>
          <div className="text-[10.5px] leading-4 text-cream-dim">{tooltipText(hoverPoint)}</div>
          {hoverPoint.forecast && (
            <div className="text-[9.5px] leading-[14px] text-cream-faint">{t('boards.chart.forecast')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function TodoBody({
  widget,
  onConfigChange
}: {
  widget: BoardWidget
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const t = useT()
  const items: TodoItem[] = Array.isArray(widget.config.items)
    ? (widget.config.items as TodoItem[])
    : []
  const [draft, setDraft] = useState('')
  const atLimit = items.length >= BOARD_LIMITS.maxTodoItems
  const save = (next: TodoItem[]) => onConfigChange({ items: next })
  const add = () => {
    const text = draft.trim()
    if (!text || atLimit) return
    setDraft('')
    save([...items, { id: crypto.randomUUID(), text: text.slice(0, BOARD_LIMITS.maxTodoTextLength), done: false }])
  }
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {items.length === 0 && (
          <div className="px-1.5 py-1 text-[11px] text-cream-faint">{t('boards.todoEmpty')}</div>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="group/item flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-overlay"
          >
            <button
              onClick={() => save(items.map((it) => (it.id === item.id ? { ...it, done: !it.done } : it)))}
              title={item.done ? t('boards.todoUndone') : t('boards.todoDone')}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition ${
                item.done ? 'border-accent bg-accent text-ink-950' : 'border-ink-600 text-transparent'
              }`}
            >
              <Check size={10} strokeWidth={3} />
            </button>
            <span
              className={`min-w-0 flex-1 break-words text-[12px] leading-4 ${
                item.done ? 'text-cream-faint line-through' : 'text-cream'
              }`}
            >
              {item.text}
            </span>
            <button
              onClick={() => save(items.filter((it) => it.id !== item.id))}
              title={t('boards.todoRemove')}
              className="shrink-0 rounded p-0.5 text-cream-faint opacity-0 transition hover:bg-red-500/15 hover:text-red-500 group-hover/item:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
        }}
        disabled={atLimit}
        placeholder={atLimit ? t('boards.todoLimit') : t('boards.todoPlaceholder')}
        className="mt-1.5 w-full shrink-0 rounded-lg border border-line bg-ink-900 px-2 py-1 text-[12px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  )
}

function LinkBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const url = typeof widget.config.url === 'string' ? widget.config.url : ''
  const [openError, setOpenError] = useState(false)
  let host = url
  try {
    host = new URL(url).host
  } catch {
    // Invalid URL — show it raw; the click guard below blocks opening it.
  }
  const open = async () => {
    setOpenError(false)
    // Re-check at click time; the main process enforces the same policy.
    if (!isValidLinkUrl(url)) {
      setOpenError(true)
      return
    }
    try {
      const result = await window.electronAPI.authOpenLoginUrl(url)
      if (!result.ok) setOpenError(true)
    } catch {
      setOpenError(true)
    }
  }
  return (
    <div className="relative h-full">
      <button
        onClick={() => void open()}
        title={t('boards.linkOpen')}
        className="group/link flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg transition hover:bg-overlay"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent transition group-hover/link:bg-accent group-hover/link:text-ink-950">
          <ExternalLink size={14} />
        </span>
        <span className="max-w-full truncate px-2 font-mono text-[11px] text-cream-dim transition group-hover/link:text-accent">
          {host}
        </span>
      </button>
      {openError && (
        <p role="alert" className="absolute inset-x-1 bottom-1 rounded bg-red-500/10 px-1.5 py-1 text-center text-[10px] leading-3 text-red-500">
          {t('boards.linkOpenFailed')}
        </p>
      )}
    </div>
  )
}

type FileBodyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'html'; html: string }
  | { kind: 'error'; error: string }

/**
 * Live-file card: content is fetched from Main through the workspace grant,
 * re-fetched when boards:file-changed reports a newer mtime for THIS card,
 * and rendered as an <img> (data URL) or a sandboxed iframe (allow-scripts
 * only — no same-origin, so the page cannot touch app storage or the DOM of
 * the board).
 */
function FileBody({ widget, boardId }: { widget: BoardWidget; boardId: string }) {
  const t = useT()
  const filePath = configStr(widget.config.filePath)
  const [state, setState] = useState<FileBodyState>({ kind: 'idle' })
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!filePath) return
    let alive = true
    setState({ kind: 'loading' })
    window.electronAPI
      .readBoardWidgetFile({ boardId, widgetId: widget.id, workspaceGrantId: useAppStore.getState().currentWorkspace?.id ?? '' })
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setState(result.kind === 'image' ? { kind: 'image', dataUrl: result.dataUrl } : { kind: 'html', html: result.html })
        } else {
          setState({ kind: 'error', error: result.error })
        }
      })
      .catch(() => {
        if (alive) setState({ kind: 'error', error: 'read-failed' })
      })
    return () => {
      alive = false
    }
  }, [boardId, widget.id, filePath, reloadTick])

  useEffect(() => {
    if (!filePath) return
    return window.electronAPI.onBoardFileChanged((change) => {
      if (change.boardId === boardId && change.widgetId === widget.id) setReloadTick((tick) => tick + 1)
    })
  }, [boardId, widget.id, filePath])

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[11px] text-cream-faint">
        {t('boards.config.noFile')}
      </div>
    )
  }
  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[11px] text-cream-faint">
        {t('app.loading')}
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-[11px] text-cream-faint">
        <FileWarning size={14} className="text-cream-faint" />
        {t('boards.files.loadFailed')}
      </div>
    )
  }
  if (state.kind === 'image') {
    // The data URL is unique per read, so no extra cache-busting is needed.
    return (
      <div className="flex h-full items-center justify-center overflow-hidden">
        <img src={state.dataUrl} alt={widget.title} className="max-h-full max-w-full rounded object-contain" />
      </div>
    )
  }
  return (
    <iframe
      title={`${widget.title} preview`}
      srcDoc={state.html}
      // allow-scripts WITHOUT allow-same-origin: the page runs with an opaque
      // origin — no app storage, no same-origin DOM access, no top navigation.
      sandbox="allow-scripts"
      className="h-full w-full rounded border-0 bg-white"
    />
  )
}

export function WidgetBody({ widget, datasets, boardId, onConfigChange }: WidgetBodyProps) {
  switch (widget.type) {
    case 'clock':
      return <ClockBody widget={widget} />
    case 'fb-reading':
      return <FbReadingBody widget={widget} />
    case 'fb-reading-summary':
      return <FbReadingSummaryBody widget={widget} />
    case 'tt-reading':
      return <TTReadingBody widget={widget} />
    case 'note':
      return <NoteBody widget={widget} />
    case 'counter':
      return <CounterBody widget={widget} datasets={datasets} />
    case 'gauge':
      return <GaugeBody widget={widget} />
    case 'chart-line':
      return <ChartBody widget={widget} bar={false} datasets={datasets} />
    case 'chart-bar':
      return <ChartBody widget={widget} bar={true} datasets={datasets} />
    case 'todo':
      return <TodoBody widget={widget} onConfigChange={onConfigChange} />
    case 'link':
      return <LinkBody widget={widget} />
    case 'file':
      return <FileBody widget={widget} boardId={boardId} />
  }
}
