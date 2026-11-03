import { useEffect, useState } from 'react'
import { Check, ExternalLink, FileWarning, X } from 'lucide-react'
import { FbReadingBody } from './FbReadingBody'
import { FbReportReadingBody } from './FbReportReadingBody'
import { FbReadingSummaryBody } from './FbReadingSummaryBody'
import { TTReadingBody } from './TTReadingBody'
import { GoogleReportReadingBody } from './GoogleReportReadingBody'
import { ReadingSnapshotBody } from './ReadingSnapshotBody'
import { ReadingModuleBody } from './ReadingModuleBody'
import { HtmlChart } from './HtmlChart'
import { HtmlFilePreview } from './HtmlFilePreview'
import { BoardDataset, BoardWidget, KanbanBoard } from '@shared/types'
import { BOARD_LIMITS, TodoItem, isValidLinkUrl } from '@shared/boards'
import {
  DATASET_OPS,
  DatasetOp,
  columnIndex,
  filterDatasetRowsByWindowWithStatus
} from '@shared/datasets'
import { usdHint, useFxRates } from '../../lib/fxRates'
import { hasAmbiguousAdvertiserFilter, metricCurrencySafety, safeMetricGroups, safeMetricValue, uniformCurrency } from '../../lib/boardMetricSafety'
import { useTweenNumber } from '../../lib/useTweenNumber'
import { useAppStore } from '../../store'
import { useT } from '../../i18n'
import { filterTikTokDatasetByScope, type VerifiedTikTokScope } from '../../lib/tiktokDatasetScope'

/**
 * Per-type widget bodies for the board grid. Charts use HTML and CSS
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
  onSnapshotSaved?: (board: KanbanBoard, openAi?: boolean, widgetId?: string) => void
  autoOpenAi?: boolean
  onAiOpened?: () => void
  showReadingSource?: boolean
  /** Board master-scope window: dataset-bound widgets filter rows to it, so
   *  switching the master range re-scopes every card instantly. latestDay
   *  marks the 今天 scope — the account's CURRENT stat day, not a calendar
   *  date (stat days live in the account's timezone). */
  masterWindow?: { start: string; end: string; latestDay?: boolean }
  /** First dataset snapshot still loading (cards show skeletons). */
  datasetsLoading?: boolean
  ttScope?: VerifiedTikTokScope | null
  ttScopeRequired?: boolean
  ttScopeConflict?: boolean
}

function configOp(value: unknown): DatasetOp {
  return typeof value === 'string' && (DATASET_OPS as readonly string[]).includes(value)
    ? (value as DatasetOp)
    : 'sum'
}

function configStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The live scope label for a dataset-bound card: which window the shown
 * numbers actually cover. Widget titles are static text — the scope chip is
 * the truth-teller (今天 · 10-29 when following the account's current day,
 * plain date ranges otherwise).
 */
function datasetScopeLabel(
  dataset: BoardDataset,
  masterWindow?: { start: string; end: string; latestDay?: boolean }
): string | null {
  if (!masterWindow) return null
  const dateIndex = dataset.columns.findIndex((column) => column.type === 'date')
  if (dateIndex < 0) return null
  const short = (iso: string) => iso.slice(5)
  if (masterWindow.latestDay) {
    const days = dataset.rows.map(row => row[dateIndex]).filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()
    if (!days.length) return null
    return days[0] === days[days.length - 1] ? days[0] : `${days[0]} – ${days[days.length - 1]}`
  }
  return masterWindow.start === masterWindow.end
    ? short(masterWindow.start)
    : `${short(masterWindow.start)}~${short(masterWindow.end)}`
}

function tikTokScopeLabel(scope: VerifiedTikTokScope): string {
  const start = scope.windows.map((window) => window.startDate).sort()[0]
  const end = scope.windows.map((window) => window.endDate).sort().at(-1)
  return start === end ? start : `${start} – ${end}`
}

/** Outcome of resolving a widget's dataset binding against the loaded datasets. */
type Binding =
  | { kind: 'ok'; dataset: BoardDataset; metricIndex: number; dimIndex: number }
  | { kind: 'missing-dataset' | 'missing-column' | 'incomplete' | 'ambiguous-account' | 'timezone-unavailable' | 'tt-unverified' | 'tt-conflict' }

function resolveBinding(
  widget: BoardWidget,
  datasets: BoardDataset[],
  needsDim: boolean,
  masterWindow?: { start: string; end: string; latestDay?: boolean },
  ttScope?: VerifiedTikTokScope | null,
  ttScopeRequired = false,
  ttScopeConflict = false
): Binding {
  const datasetId = configStr(widget.config.datasetId)
  const metric = configStr(widget.config.metric)
  const dimension = configStr(widget.config.dimension)
  if (!datasetId || !metric || (needsDim && !dimension)) return { kind: 'incomplete' }
  // Preset templates bind by dataset NAME ("TikTok 报表") — id match first,
  // name fallback so template widgets resolve without knowing generated ids.
  const found = datasets.find((d) => d.id === datasetId) ?? datasets.find((d) => d.name === datasetId)
  if (!found) return { kind: 'missing-dataset' }
  // Row filter FIRST (e.g. 广告主=miclip, or a multi-account set): the 今天
  // scope's "latest stat day" must be the latest day OF THESE ADVERTISERS,
  // not of the whole dataset — otherwise another account's data decides the
  // day and this card goes empty.
  let dataset = found
  if (found.name === 'TikTok 报表' && (ttScopeRequired || widget.config.requireVerifiedTtScope === true)) {
    if (!ttScope) return { kind: ttScopeConflict ? 'tt-conflict' : 'tt-unverified' }
    const scoped = filterTikTokDatasetByScope(found, ttScope)
    if (!scoped) return { kind: 'tt-unverified' }
    dataset = scoped
  }
  const filterColumn = configStr(widget.config.filterColumn)
  const filterValue = configStr(widget.config.filterValue)
  const filterValues = Array.isArray(widget.config.filterValues)
    ? widget.config.filterValues.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  if (filterColumn && (filterValues.length > 0 || filterValue)) {
    if (hasAmbiguousAdvertiserFilter(dataset, filterColumn, filterValues.length ? filterValues : [filterValue])) return { kind: 'ambiguous-account' }
    const filterIndex = columnIndex(dataset, filterColumn)
    if (filterIndex < 0) return { kind: 'missing-column' }
    // Multi-account boards: OR-match the set; single value stays a set of one.
    const allowed = new Set(filterValues.length > 0 ? filterValues : [filterValue])
    dataset = { ...dataset, rows: dataset.rows.filter((row) => allowed.has(String(row[filterIndex]))) }
  }
  // Master-scope window on top: dataset cards follow the board's range; the
  // 今天 scope shows the account's CURRENT stat day (latest among filtered rows).
  if (masterWindow && !(found.name === 'TikTok 报表' && (ttScopeRequired || widget.config.requireVerifiedTtScope === true))) {
    const scope = filterDatasetRowsByWindowWithStatus(dataset, masterWindow, masterWindow.latestDay ? { latestDay: true } : undefined)
    if (scope.missingTimezone) return { kind: 'timezone-unavailable' }
    dataset = scope.dataset
  }
  const metricIndex = columnIndex(dataset, metric)
  const dimIndex = needsDim ? columnIndex(dataset, dimension) : -1
  if (metricIndex < 0 || (needsDim && dimIndex < 0)) return { kind: 'missing-column' }
  return { kind: 'ok', dataset, metricIndex, dimIndex }
}

function BindingPlaceholder({
  binding,
  widget,
  loading = false
}: {
  binding: Binding
  widget: BoardWidget
  loading?: boolean
}) {
  const t = useT()
  // First dataset snapshot still loading: keep the card's geometry with a
  // shimmer instead of flashing "dataset not available yet" then popping to
  // numbers a beat later.
  if (loading && binding.kind === 'missing-dataset') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-2.5 w-1/3" />
      </div>
    )
  }
  const text =
    binding.kind === 'missing-dataset'
      ? // Template widgets bind by dataset NAME and may legitimately point at a
        // dataset that does not exist YET (e.g. a fresh TikTok board before the
        // first report pull) — guide the user instead of crying "deleted".
        t('boards.datasets.datasetMissing', { name: configStr(widget.config.datasetId) })
      : binding.kind === 'tt-conflict'
        ? t('boards.datasets.ttScopeConflict')
      : binding.kind === 'tt-unverified'
        ? t('boards.datasets.ttScopeUnverified')
      : binding.kind === 'timezone-unavailable'
        ? t('boards.datasets.timezoneUnavailable')
      : binding.kind === 'ambiguous-account'
        ? t('boards.datasets.ambiguousAccount')
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

/** The big KPI number: tweens toward its new value instead of snapping. */
function CounterValue({ value, className, animate = true }: { value: number | null; className: string; animate?: boolean }) {
  const tween = useTweenNumber(animate ? value : null)
  const shown = animate ? (value === null ? null : tween) : value
  return (
    <div className={className}>
      {shown === null ? '—' : shown.toLocaleString('en-US', { maximumFractionDigits: 2 })}
    </div>
  )
}

function CounterBody({
  widget,
  datasets,
  masterWindow,
  datasetsLoading,
  ttScope,
  ttScopeRequired,
  ttScopeConflict
}: {
  widget: BoardWidget
  datasets: BoardDataset[]
  masterWindow?: { start: string; end: string; latestDay?: boolean }
  datasetsLoading?: boolean
  ttScope?: VerifiedTikTokScope | null
  ttScopeRequired?: boolean
  ttScopeConflict?: boolean
}) {
  const t = useT()
  const label = typeof widget.config.label === 'string' ? widget.config.label : ''
  const fxRates = useFxRates()
  let value: number | null
  let usdHintText: string | null = null
  let currencyBadge: string | null = null
  let scopeLabel: string | null = null
  if (widget.config.source === 'dataset') {
    const binding = resolveBinding(widget, datasets, false, masterWindow, ttScope, ttScopeRequired, ttScopeConflict)
    if (binding.kind !== 'ok') return <BindingPlaceholder binding={binding} widget={widget} loading={datasetsLoading} />
    // The live 口径 label: what window the number actually covers (the
    // widget's own title is static text and must never mislead about scope).
    scopeLabel = binding.dataset.name === 'TikTok 报表' && ttScope && ttScopeRequired ? tikTokScopeLabel(ttScope) : datasetScopeLabel(binding.dataset, masterWindow)
    if (!scopeLabel && !masterWindow && binding.dataset.name === 'TikTok 报表') scopeLabel = t('boards.datasets.ttAllHistory')
    // An empty window-filtered slice is "no data in this range", not zero.
    if (binding.dataset.rows.length === 0) value = null
    else {
      const safety = metricCurrencySafety(binding.dataset, configStr(widget.config.metric))
      value = safety === 'mixed' || safety === 'unknown' ? null : safeMetricValue(binding.dataset, binding.dataset.rows, binding.metricIndex, configOp(widget.config.op))
      const currency = uniformCurrency(binding.dataset)
      if (safety === 'mixed') currencyBadge = 'MIX'
      else if (safety === 'unknown') currencyBadge = '?'
      else if (safety === 'safe' && currency && currency !== 'USD') {
        currencyBadge = currency
        if (typeof value === 'number') usdHintText = usdHint(value, currencyBadge, fxRates)
      }
    }
  } else {
    value = typeof widget.config.value === 'number' ? widget.config.value : 0
  }
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-1.5">
      {currencyBadge && (
        <span
          className="absolute right-0 top-0 rounded-full border border-line px-1 py-px text-[9px] font-medium uppercase tracking-wider text-cream-faint"
          title={currencyBadge}
        >
          {currencyBadge}
        </span>
      )}
      {scopeLabel && (
        <span className="absolute left-0 top-0 text-[9px] leading-4 tabular-nums text-cream-faint/80" title={scopeLabel}>
          {scopeLabel}
        </span>
      )}
      <CounterValue value={value} animate={widget.config.source !== 'dataset'} className="break-all text-center font-mono text-[38px] leading-none tabular-nums text-cream" />
      {usdHintText && (
        <div className="text-center text-[10.5px] leading-4 tabular-nums text-cream-faint">{usdHintText}</div>
      )}
      {label && (
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-cream-faint">{label}</div>
      )}
    </div>
  )
}

/** Native HTML progress meter; no SVG is needed for editable boards. */
function GaugeBody({ widget }: { widget: BoardWidget }) {
  const value = Math.min(100, Math.max(0, typeof widget.config.value === 'number' ? widget.config.value : 0))
  const label = typeof widget.config.label === 'string' ? widget.config.label : ''
  return <div className="flex h-full flex-col items-center justify-center gap-3">
    <span className="font-mono text-[32px] tabular-nums">{Math.round(value)}%</span>
    <meter min={0} max={100} value={value} aria-label={label || 'Progress'} className="h-5 w-full" />
    {label && <span className="text-[12px] text-cream-faint">{label}</span>}
  </div>
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

/** Data bindings stay in the host; visual marks use HTML/CSS. */
function ChartBody({
  widget,
  bar,
  datasets,
  masterWindow,
  datasetsLoading,
  ttScope,
  ttScopeRequired,
  ttScopeConflict
}: {
  widget: BoardWidget
  bar: boolean
  datasets: BoardDataset[]
  masterWindow?: { start: string; end: string; latestDay?: boolean }
  datasetsLoading?: boolean
  ttScope?: VerifiedTikTokScope | null
  ttScopeRequired?: boolean
  ttScopeConflict?: boolean
}) {
  const t = useT()
  let points: ChartPoint[]
  let labels: string[]
  let chartScopeLabel: string | null = null
  let chartCurrency: string | null = null
  let metricName = ''
  if (widget.config.source === 'dataset') {
    const binding = resolveBinding(widget, datasets, true, masterWindow, ttScope, ttScopeRequired, ttScopeConflict)
    if (binding.kind !== 'ok') return <BindingPlaceholder binding={binding} widget={widget} loading={datasetsLoading} />
    chartScopeLabel = binding.dataset.name === 'TikTok 报表' && ttScope && ttScopeRequired ? tikTokScopeLabel(ttScope) : datasetScopeLabel(binding.dataset, masterWindow)
    if (!chartScopeLabel && !masterWindow && binding.dataset.name === 'TikTok 报表') chartScopeLabel = t('boards.datasets.ttAllHistory')
    const currency = metricCurrencySafety(binding.dataset, configStr(widget.config.metric))
    if (currency === 'safe') chartCurrency = uniformCurrency(binding.dataset)
    if (currency === 'mixed' || currency === 'unknown') return <div role="status" className="flex h-full items-center justify-center px-2 text-center text-[11px] text-cream-faint">{t('boards.datasets.currencyUnavailable')}</div>
    const grouped = safeMetricGroups(binding.dataset, binding.dimIndex, binding.metricIndex, configOp(widget.config.op), t('boards.datasets.other'))
    if (!grouped) return <div role="status" className="flex h-full items-center justify-center px-2 text-center text-[11px] text-cream-faint">{t('boards.datasets.metricUnavailable')}</div>
    points = grouped.points.map(parseChartPoint).filter((p): p is ChartPoint => p !== null)
    labels = grouped.labels
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
  const showValues = typeof widget.config.showValues === 'boolean' ? widget.config.showValues : bar || points.length <= 12
  return <HtmlChart points={points} labels={labels} bar={bar} title={metricName || widget.title || (bar ? 'Bar chart' : 'Line chart')}
    scope={chartScopeLabel} currency={chartCurrency} forecastLabel={t('boards.chart.forecast')} showValues={showValues} />
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
  const language = useAppStore(state => state.language)
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
  return <HtmlFilePreview html={state.html} title={widget.title} language={language === 'en' ? 'en' : 'zh'} />
}

export function WidgetBody({ widget, datasets, boardId, onConfigChange, onSnapshotSaved, autoOpenAi, onAiOpened, showReadingSource, masterWindow, datasetsLoading, ttScope, ttScopeRequired, ttScopeConflict }: WidgetBodyProps) {
  switch (widget.type) {
    case 'clock':
      return <ClockBody widget={widget} />
    case 'fb-reading':
      return <FbReadingBody widget={widget} />
    case 'fb-reading-summary':
      return <FbReadingSummaryBody widget={widget} />
    case 'fb-report-reading':
      return <FbReportReadingBody widget={widget} onConfigChange={onConfigChange} />
    case 'google-report-reading':
      return <GoogleReportReadingBody widget={widget} onSnapshotSaved={onSnapshotSaved} />
    case 'tt-reading':
      return <TTReadingBody widget={widget} />
    case 'reading-module':
      return <ReadingModuleBody widget={widget} boardId={boardId} autoOpenAi={autoOpenAi} onAiOpened={onAiOpened} />
    case 'reading-snapshot':
      return <ReadingSnapshotBody widget={widget} boardId={boardId} autoOpenAi={autoOpenAi} onAiOpened={onAiOpened} showReadingSource={showReadingSource} />
    case 'note':
      return <NoteBody widget={widget} />
    case 'counter':
      return <CounterBody widget={widget} datasets={datasets} masterWindow={masterWindow} datasetsLoading={datasetsLoading} ttScope={ttScope} ttScopeRequired={ttScopeRequired} ttScopeConflict={ttScopeConflict} />
    case 'gauge':
      return <GaugeBody widget={widget} />
    case 'chart-line':
      return <ChartBody widget={widget} bar={false} datasets={datasets} masterWindow={masterWindow} datasetsLoading={datasetsLoading} ttScope={ttScope} ttScopeRequired={ttScopeRequired} ttScopeConflict={ttScopeConflict} />
    case 'chart-bar':
      return <ChartBody widget={widget} bar={true} datasets={datasets} masterWindow={masterWindow} datasetsLoading={datasetsLoading} ttScope={ttScope} ttScopeRequired={ttScopeRequired} ttScopeConflict={ttScopeConflict} />
    case 'todo':
      return <TodoBody widget={widget} onConfigChange={onConfigChange} />
    case 'link':
      return <LinkBody widget={widget} />
    case 'file':
      return <FileBody widget={widget} boardId={boardId} />
  }
}
