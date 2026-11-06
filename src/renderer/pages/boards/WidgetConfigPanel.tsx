import { useMemo, useRef, useState } from 'react'
import { Check, FilePlus2, X } from 'lucide-react'
import { BoardDataset, BoardMasterScope, BoardWidget, BoardWidgetStyle } from '@shared/types'
import { GRID_COLS, GRID_MAX_H, MASTER_SCOPED_WIDGET_TYPES, ttWindowForMasterRange } from '@shared/boards'
import { fbReadingMetricLabel, fbReadingRangeLabel, ttReadingRangeLabel } from './metricLabel'
import { BOARD_LIMITS, isValidLinkUrl } from '@shared/boards'
import { DATASET_OPS, DatasetOp } from '@shared/datasets'
import type { FunnelStage } from '@shared/boardDataWidgets'
import { boardWidgetWindow, validateWidgetDateScope, type BoardWidgetDateScope } from '@shared/boardWindows'
import { validGoogleReportUrl } from '@shared/googleReport'
import { parseTikTokAdvertiserIdList } from '@shared/tiktokReport'
import {
  FB_READING_SUMMARY_ACCOUNT_LIMIT,
  boardReadingRangeDates,
  resolveFbReadingSummaryAccounts,
  resolveFbReadingWidgetAccount
} from '@shared/fbReading'
import type { FbReadingAccountEntry, FbReadingRange } from '@shared/fbReading'
import { formatReadingWindow, tiktokReadingRangeWindow } from '@shared/todayReading'
import { useAppStore } from '../../store'
import { useT, I18nKey } from '../../i18n'
import { FbReadingAccountManager } from './FbReadingAccountManager'

/**
 * In-card widget configuration layer: covers the widget body with a small
 * form (title + per-type fields). Saving writes the whole widget back and
 * persists the board. Remounted per widget via React key, so local drafts
 * always initialize from the widget being configured.
 *
 * Counter/line/bar widgets have two data sources: manual (the historic
 * value/points fields) and dataset (a binding onto an imported dataset:
 * datasetId + metric column + aggregation op, plus a dimension column for
 * charts). Both sides' drafts live in state and are written back together,
 * so toggling the source never discards the other side's input.
 */

interface WidgetConfigPanelProps {
  widget: BoardWidget
  boardUpdatedAt: number
  datasets: BoardDataset[]
  /** Board master scope, when set — divergent saves become "independent". */
  masterScope?: BoardMasterScope | null
  onClose: () => void
  onSave: (patch: { title: string; config: Record<string, unknown>; style?: BoardWidgetStyle; dateScope?: BoardWidgetDateScope; dimensions?: { width: number; height: number }; expectedUpdatedAt: number }) => Promise<boolean>
}

const inputClass =
  'w-full rounded-lg border border-line bg-ink-850 px-2 py-1 text-[12px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10.5px] text-cream-faint">{label}</span>
      {children}
    </label>
  )
}

/**
 * Field variant for pill-button groups: a plain div, NOT a <label>. A
 * label click on its own whitespace synthetic-clicks its first button
 * child, silently toggling a pill — "clicked beside 余额, spend turned
 * off" is that bug, not intended behavior.
 */
function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-0.5 block text-[10.5px] text-cream-faint">{label}</span>
      {children}
    </div>
  )
}

function configString(widget: BoardWidget, key: string): string {
  const value = widget.config[key]
  return typeof value === 'string' ? value : ''
}

export function WidgetConfigPanel({ widget, boardUpdatedAt, datasets, masterScope = null, onClose, onSave }: WidgetConfigPanelProps) {
  const t = useT()
  const language = useAppStore(state => state.language)
  const openedVersion = useRef(boardUpdatedAt)
  const saving = useRef(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [title, setTitle] = useState(widget.title)
  const [width, setWidth] = useState(String(widget.layout.w))
  const [height, setHeight] = useState(String(widget.layout.h))
  const [sizeDirty, setSizeDirty] = useState(false)
  const [sizeError, setSizeError] = useState(false)
  const [showSeconds, setShowSeconds] = useState(widget.config.showSeconds !== false)
  const [text, setText] = useState(configString(widget, 'text'))
  const [numValue, setNumValue] = useState(() => {
    const value = widget.config.value
    return typeof value === 'number' ? String(value) : ''
  })
  const [label, setLabel] = useState(configString(widget, 'label'))
  const [pointsText, setPointsText] = useState(() =>
    Array.isArray(widget.config.points) ? (widget.config.points as number[]).join(', ') : ''
  )
  const [labelsText, setLabelsText] = useState(() =>
    Array.isArray(widget.config.labels) ? (widget.config.labels as string[]).join(', ') : ''
  )
  // "Show values" per chart widget. Unset config falls back to the same
  // effective default the body renders: always on for bars (thin bars
  // degrade to hover-only), on for lines with at most 12 points.
  const [showValues, setShowValues] = useState(() => {
    const raw = widget.config.showValues
    if (typeof raw === 'boolean') return raw
    if (widget.type === 'chart-line') {
      return Array.isArray(widget.config.points) ? widget.config.points.length <= 12 : true
    }
    return true
  })
  const [url, setUrl] = useState(configString(widget, 'url'))
  const [urlInvalid, setUrlInvalid] = useState(false)
  const [googleReportUrl, setGoogleReportUrl] = useState(configString(widget, 'reportUrl'))
  const [googleUrlInvalid, setGoogleUrlInvalid] = useState(false)
  const [labelsInvalid, setLabelsInvalid] = useState(false)
  const [style, setStyle] = useState<BoardWidgetStyle>(widget.style ?? {})
  const [dateMode, setDateMode] = useState<BoardWidgetDateScope['mode']>(widget.dateScope?.mode ?? 'inherit')
  const [lookbackDays, setLookbackDays] = useState(widget.dateScope?.mode === 'lookback' ? widget.dateScope.days : 7)
  const initialWindow = boardWidgetWindow({ ...(masterScope ? { masterScope } : {}) }, widget)
  const [absoluteStart, setAbsoluteStart] = useState(initialWindow.start)
  const [absoluteEnd, setAbsoluteEnd] = useState(initialWindow.end)
  const [dateDirty, setDateDirty] = useState(false)
  const [dateError, setDateError] = useState(false)

  // File widget binding: the native picker returns a workspace-RELATIVE path
  // from Main (validated against the active workspace grant). Drafted here
  // like every other field; committed on Save through the normal board write.
  const currentWorkspace = useAppStore((state) => state.currentWorkspace)
  const [boundPath, setBoundPath] = useState(configString(widget, 'filePath'))
  const [pickBusy, setPickBusy] = useState(false)
  const [pickError, setPickError] = useState<I18nKey | null>(null)

  // FB reading module: pinned account + date window + metric set.
  const [readingRange, setReadingRange] = useState(
    widget.config.range === 'today' || widget.config.range === 'yesterday' || widget.config.range === 'last3' || widget.config.range === 'last30'
      ? (widget.config.range as 'today' | 'yesterday' | 'last3' | 'last30')
      : 'last7'
  )
  const [readingMetrics, setReadingMetrics] = useState<string[]>(() => {
    const raw = widget.config.metrics
    return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : ['spend', 'cpi']
  })
  const [accounts, setAccounts] = useState<FbReadingAccountEntry[]>([])
  const [selectedAct, setSelectedAct] = useState(
    () => resolveFbReadingWidgetAccount(widget.config)?.act ?? ''
  )
  const [manageOpen, setManageOpen] = useState(false)
  const [accountError, setAccountError] = useState<'none' | 'limit' | null>(null)
  const [summarySelectedActs, setSummarySelectedActs] = useState<Set<string>>(
    () => new Set(resolveFbReadingSummaryAccounts(widget.config).map((account) => account.act))
  )
  const [readingMetricEmpty, setReadingMetricEmpty] = useState(false)
  const [summaryFilter, setSummaryFilter] = useState('')

  // TT 读数 module: optional advertiser-id list + day-window enum.
  const [ttAdvertiserIds, setTtAdvertiserIds] = useState(configString(widget, 'advertiserIds'))
  const [ttRange, setTtRange] = useState<'1' | 'yd' | '3' | '7' | '28' | '30'>(
    widget.config.range === '1' || widget.config.range === 'yd' || widget.config.range === '3' || widget.config.range === '28' || widget.config.range === '30'
      ? (widget.config.range as '1' | 'yd' | '3' | '28' | '30')
      : '7'
  )

  const summaryAccountOptions = useMemo(() => {
    const merged = new Map<string, FbReadingAccountEntry>()
    for (const account of resolveFbReadingSummaryAccounts(widget.config)) {
      merged.set(account.act, { ...account, id: account.act, createdAt: 0 })
    }
    for (const account of accounts) merged.set(account.act, account)
    return Array.from(merged.values())
  }, [accounts, widget.config])

  const summaryFilterQuery = summaryFilter.trim().toLowerCase()
  const visibleSummaryAccounts = summaryFilterQuery === ''
    ? summaryAccountOptions
    : summaryAccountOptions.filter(
        (entry) => entry.alias.toLowerCase().includes(summaryFilterQuery) || entry.act.includes(summaryFilterQuery)
      )

  const selectedAccount = accounts.find((entry) => entry.act === selectedAct) ?? null
  const handleReadingAccountsChange = (entries: FbReadingAccountEntry[]) => {
    setAccounts(entries)
    setSelectedAct((prev) => (entries.some((entry) => entry.act === prev) ? prev : ''))
  }

  const handleReadingAccountsAdded = (entries: FbReadingAccountEntry[]) => {
    const acts = entries.map((entry) => entry.act)
    if (acts.length > 0) setSelectedAct(acts[0])
    setSummarySelectedActs((prev) => new Set([...prev, ...acts]))
    setAccountError(null)
  }

  const handleReadingAccountsRemoved = (acts: string[]) => {
    const removed = new Set(acts)
    setSummarySelectedActs((prev) => new Set([...prev].filter((act) => !removed.has(act))))
    setAccountError(null)
  }

  const readingMetricLabel = (value: string): string => fbReadingMetricLabel(t, value)

  const pickFile = async () => {
    if (!currentWorkspace || pickBusy) return
    setPickBusy(true)
    setPickError(null)
    try {
      const result = await window.electronAPI.selectBoardWidgetFile(currentWorkspace.id)
      if (!result) return // picker canceled
      if (result.ok) setBoundPath(result.relativePath)
      else
        setPickError(
          result.error === 'no-workspace'
            ? 'boards.files.noWorkspace'
            : result.error === 'unsupported-type'
              ? 'boards.files.unsupportedType'
              : 'boards.files.outsideWorkspace'
        )
    } catch {
      setPickError('boards.files.noWorkspace')
    } finally {
      setPickBusy(false)
    }
  }

  // Dataset binding: tables and highlights always keep a source reference.
  const datasetOnly = widget.type === 'table' || widget.type === 'analysis'
  const supportsDataset =
    widget.type === 'counter' || widget.type === 'chart-line' || widget.type === 'chart-bar' || datasetOnly
  const isChart = widget.type === 'chart-line' || widget.type === 'chart-bar'
  const [source, setSource] = useState<'manual' | 'dataset'>(
    datasetOnly || widget.config.source === 'dataset' ? 'dataset' : 'manual'
  )
  const [datasetId, setDatasetId] = useState(configString(widget, 'datasetId'))
  const [metric, setMetric] = useState(configString(widget, 'metric'))
  const [op, setOp] = useState<DatasetOp>(() =>
    (DATASET_OPS as readonly string[]).includes(widget.config.op as string)
      ? (widget.config.op as DatasetOp)
      : 'sum'
  )
  const [dimension, setDimension] = useState(configString(widget, 'dimension'))
  const [tableColumns, setTableColumns] = useState<string[]>(() => Array.isArray(widget.config.columns)
    ? widget.config.columns as string[] : (datasets.find(dataset => dataset.id === widget.config.datasetId || dataset.name === widget.config.datasetId)?.columns ?? []).slice(0, 8).map(column => column.name))
  const [pageSize, setPageSize] = useState(typeof widget.config.pageSize === 'number' ? widget.config.pageSize : 20)
  const [sortColumn, setSortColumn] = useState(configString(widget, 'sortColumn'))
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(widget.config.sortDirection === 'desc' ? 'desc' : 'asc')
  const [funnelStages, setFunnelStages] = useState<FunnelStage[]>(() => Array.isArray(widget.config.stages) && widget.config.stages.length
    ? widget.config.stages as FunnelStage[] : Array.from({ length: 2 }, () => ({ source: 'dataset', label: '', datasetId: '', metric: '', op: 'sum' })))

  const setStyleColor = (key: 'accent' | 'surface' | 'text' | 'border', value: string) => {
    setStyle((current) => ({ ...current, [key]: value }))
  }

  const selectedDataset = datasets.find((d) => d.id === datasetId || d.name === datasetId)
  const metricColumns = (selectedDataset?.columns ?? []).filter((c) => c.type === 'number')
  const datasetIncomplete =
    (supportsDataset && source === 'dataset' && (!datasetId || (widget.type === 'table' ? tableColumns.length === 0 : !metric) || (isChart && !dimension))) ||
    (widget.type === 'funnel' && (funnelStages.length < 2 || funnelStages.some(stage => !stage.label.trim() || !stage.datasetId || !stage.metric)))

  /** Dataset fields kept alongside the manual ones so toggling loses nothing. */
  const bindingConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = { source, op }
    if (datasetId) config.datasetId = datasetId
    if (metric) config.metric = metric
    if (isChart && dimension) config.dimension = dimension
    return config
  }

  const handleSave = async () => {
    if (datasetIncomplete || saving.current) return
    const dateScope = validateWidgetDateScope(dateMode === 'lookback' ? { mode: dateMode, days: lookbackDays, anchor: 'reportEnd' } : dateMode === 'absolute' ? { mode: dateMode, start: absoluteStart, end: absoluteEnd } : { mode: 'inherit' })
    if (dateDirty && !dateScope) { setDateError(true); return }
    const w = Number(width), h = Number(height)
    if (sizeDirty && (!Number.isSafeInteger(w) || w < 2 || w > GRID_COLS || !Number.isSafeInteger(h) || h < 2 || h > GRID_MAX_H)) { setSizeError(true); return }
    let config: Record<string, unknown>
    switch (widget.type) {
      case 'reading-module':
      case 'reading-snapshot':
        // Saved snapshots are immutable. Editing a title or appearance must
        // never discard or rewrite the underlying reading.
        config = widget.config
        break
      case 'clock':
        config = { showSeconds }
        break
      case 'note':
        config = { text: text.slice(0, BOARD_LIMITS.maxNoteLength) }
        break
      case 'counter': {
        const value = Number(numValue)
        config = {
          value: Number.isFinite(value) ? value : 0,
          label: label.slice(0, BOARD_LIMITS.maxLabelLength),
          ...bindingConfig()
        }
        break
      }
      case 'table':
        config = { source: 'dataset', datasetId, columns: tableColumns, pageSize, ...(sortColumn ? { sortColumn, sortDirection } : {}) }
        break
      case 'funnel':
        config = { source: 'dataset', stages: funnelStages }
        break
      case 'analysis':
        config = { ...bindingConfig(), ...(dimension ? { dimension } : {}) }
        break
      case 'gauge': {
        let value = Number(numValue)
        if (!Number.isFinite(value)) value = 0
        config = {
          value: Math.min(100, Math.max(0, value)),
          label: label.slice(0, BOARD_LIMITS.maxLabelLength)
        }
        break
      }
      case 'chart-line':
      case 'chart-bar': {
        const points = pointsText
          .split(/[,，\s]+/)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n))
          .slice(0, BOARD_LIMITS.maxChartPoints)
        const labels = labelsText
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, BOARD_LIMITS.maxChartPoints)
        if (labels.some((entry) => entry.length > BOARD_LIMITS.maxChartLabelLength)) {
          setLabelsInvalid(true)
          return
        }
        config = { points, labels, showValues, ...bindingConfig() }
        break
      }
      case 'todo':
        // Items are managed directly in the widget body — keep them as-is.
        config = { items: Array.isArray(widget.config.items) ? widget.config.items : [] }
        break
      case 'link': {
        const trimmed = url.trim()
        if (!isValidLinkUrl(trimmed)) {
          setUrlInvalid(true)
          return
        }
        config = { url: trimmed }
        break
      }
      case 'file':
        // Keep the previously bound path when no new file was picked.
        config = { filePath: boundPath }
        break
      case 'google-report-reading': {
        const reportUrl = googleReportUrl.trim()
        if (reportUrl && !validGoogleReportUrl(reportUrl)) { setGoogleUrlInvalid(true); return }
        config = { reportUrl }
        break
      }
      case 'fb-report-reading':
        config = { ...widget.config }
        break
      case 'fb-reading':
        {
          const ref = selectedAccount ?? resolveFbReadingWidgetAccount(widget.config)
          if (!ref) {
            setAccountError('none')
            return
          }
          if (readingMetrics.length === 0) {
            setReadingMetricEmpty(true)
            return
          }
          config = { account: ref.alias, act: ref.act, businessId: ref.businessId, range: readingRange, metrics: readingMetrics }
        }
        break
      case 'fb-reading-summary': {
        const selected = summaryAccountOptions.filter((account) => summarySelectedActs.has(account.act))
        if (selected.length === 0) {
          setAccountError('none')
          return
        }
        if (selected.length > FB_READING_SUMMARY_ACCOUNT_LIMIT) {
          setAccountError('limit')
          return
        }
        if (readingMetrics.length === 0) {
          setReadingMetricEmpty(true)
          return
        }
        config = {
          accounts: selected.map((account) => ({ alias: account.alias, act: account.act, businessId: account.businessId })),
          range: readingRange,
          metrics: readingMetrics
        }
        break
      }
      case 'meta-reading':
        config = { ...widget.config }
        break
      case 'tt-reading':
        // Empty advertiserIds is valid: the token's own grant covers all.
        config = { advertiserIds: ttAdvertiserIds, range: ttRange }
        break
    }
    // Master scope: a reading module saved with a scope that diverges from
    // the board's master becomes independent — gated by a confirmation,
    // because it opts the module out until the next master adjustment
    // re-unifies every module. Converging back onto the master clears it.
    if (masterScope) {
      if (MASTER_SCOPED_WIDGET_TYPES.includes(widget.type)) {
        const metrics = (config.metrics ?? []) as string[]
        const diverges =
          widget.type === 'meta-reading'
            ? config.range !== masterScope.range
            : widget.type === 'tt-reading'
            ? config.range !== ttWindowForMasterRange(masterScope.range)
            : config.range !== masterScope.range ||
              metrics.length !== masterScope.metrics.length ||
              metrics.some((metric) => !masterScope.metrics.includes(metric))
        if (diverges) {
          if (widget.config.independent !== true) {
            if (!window.confirm(t('boards.master.independentConfirm'))) return
          }
          config.independent = true
        } else {
          delete config.independent
        }
      }
    }
    // The advertiser row filter (set by cross-account board creation) has no
    // control in this panel — carry it through a save untouched, otherwise
    // saving any setting silently widens the card to every advertiser.
    for (const key of ['filterColumn', 'filterValue', 'filterValues', 'requireVerifiedTtScope'] as const) {
      if (widget.config[key] !== undefined) config[key] = widget.config[key]
    }
    saving.current = true; setSaveBusy(true); setSaveError(false)
    try {
      const ok = await onSave({
        title: title.trim() || widget.title,
        config,
        expectedUpdatedAt: openedVersion.current,
        ...(dateDirty && dateScope ? { dateScope } : {}),
        ...(sizeDirty ? { dimensions: { width: w, height: h } } : {}),
        ...(Object.keys(style).length > 0 ? { style } : {})
      })
      if (!ok) setSaveError(true)
    } catch { setSaveError(true) }
    finally { saving.current = false; setSaveBusy(false) }
  }

  return (
    <div
      className="widget-config absolute inset-0 z-20 flex flex-col rounded-[16px] border border-line bg-ink-900/95 p-3 backdrop-blur-sm"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
          {t('boards.config')}
        </span>
        <button
          onClick={onClose}
          title={t('boards.cancel')}
          className="rounded-md p-1 text-cream-faint transition hover:bg-overlay hover:text-cream"
        >
          <X size={12} />
        </button>
      </div>
      <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">
        <Field label={t('boards.config.title')}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={BOARD_LIMITS.maxWidgetTitleLength}
            className={inputClass}
          />
        </Field>
        {(supportsDataset || widget.type === 'funnel' || widget.type === 'tt-reading') && <>
          <Field label={language === 'zh' ? '日期范围' : 'Date window'}><select value={dateMode} onChange={event => { setDateMode(event.target.value as BoardWidgetDateScope['mode']); setDateDirty(true); setDateError(false) }} className={inputClass}><option value="inherit">{language === 'zh' ? '跟随总控' : 'Follow report'}</option><option value="lookback">{language === 'zh' ? '截至报表日期的近 N 天' : 'Trailing days ending on the report date'}</option><option value="absolute">{language === 'zh' ? '指定日期（仍可刷新）' : 'Specific dates (refreshable)'}</option></select></Field>
          {dateMode === 'lookback' && <Field label={language === 'zh' ? '天数' : 'Days'}><input type="number" min={1} max={30} value={lookbackDays} onChange={event => { setLookbackDays(Number(event.target.value)); setDateDirty(true); setDateError(false) }} className={inputClass} /></Field>}
          {dateMode === 'absolute' && <div className="grid grid-cols-2 gap-2"><Field label={language === 'zh' ? '开始日期' : 'Start date'}><input type="date" value={absoluteStart} onChange={event => { setAbsoluteStart(event.target.value); setDateDirty(true); setDateError(false) }} className={inputClass} /></Field><Field label={language === 'zh' ? '结束日期' : 'End date'}><input type="date" value={absoluteEnd} onChange={event => { setAbsoluteEnd(event.target.value); setDateDirty(true); setDateError(false) }} className={inputClass} /></Field></div>}
          {dateError && <p role="alert" className="text-[11px] text-red-500">{language === 'zh' ? '请填写有效范围；近 N 天为 1–30 天，指定日期最多 366 天。' : 'Use 1–30 trailing days or a valid date range up to 366 days.'}</p>}
        </>}
        <div className="grid grid-cols-2 gap-2">
          <Field label={language === 'zh' ? '宽度（网格）' : 'Width (grid units)'}><input aria-label={language === 'zh' ? '宽度（网格）' : 'Width (grid units)'} type="number" min={2} max={GRID_COLS} step={1} value={width} onChange={event => { setWidth(event.target.value); setSizeDirty(true); setSizeError(false) }} className={inputClass} /></Field>
          <Field label={language === 'zh' ? '高度（网格）' : 'Height (grid units)'}><input aria-label={language === 'zh' ? '高度（网格）' : 'Height (grid units)'} type="number" min={2} max={GRID_MAX_H} step={1} value={height} onChange={event => { setHeight(event.target.value); setSizeDirty(true); setSizeError(false) }} className={inputClass} /></Field>
        </div>
        <p className="text-[10.5px] text-cream-faint">{language === 'zh' ? '宽 2–12、高 2–20；为避免重叠，模块可能自动移动。' : 'Width 2–12, height 2–20. The card may move to avoid overlap.'}</p>
        {saveError && <p role="alert" className="text-[11px] text-red-500">{language === 'zh' ? '保存失败或看板已变化，草稿仍保留。请核对后重新打开。' : 'Save failed or the board changed. Your draft is preserved; review and reopen.'}</p>}
        {sizeError && <p role="alert" className="text-[11px] text-red-500">{language === 'zh' ? '请输入范围内的整数尺寸。' : 'Enter whole-number dimensions in range.'}</p>}
        {widget.type === 'clock' && (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-cream-dim">
            <input
              type="checkbox"
              checked={showSeconds}
              onChange={(e) => setShowSeconds(e.target.checked)}
              className="accent-[rgb(var(--accent))]"
            />
            {t('boards.config.showSeconds')}
          </label>
        )}
        {(widget.type === 'fb-reading' || widget.type === 'fb-reading-summary') && (
          <>
            {widget.type === 'fb-reading' ? (
              <Field label={t('boards.reading.config.account')}>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedAct}
                    onChange={(e) => {
                      setSelectedAct(e.target.value)
                      setAccountError(null)
                    }}
                    className={inputClass}
                  >
                    <option value="">{t('boards.reading.action.pickAccount')}</option>
                    {accounts.map((entry) => (
                      <option key={entry.id} value={entry.act}>
                        {entry.alias}（{entry.act}）
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setManageOpen((open) => !open)}
                    className="shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:text-cream"
                  >
                    {t('boards.reading.accounts.manage')}
                  </button>
                </div>
              </Field>
            ) : (
              <Field label={t('boards.reading.summary.configAccounts')}>
                {summaryAccountOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <input
                      value={summaryFilter}
                      onChange={(e) => setSummaryFilter(e.target.value)}
                      placeholder={t('boards.reading.accounts.searchAccounts')}
                      className={inputClass}
                    />
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setSummarySelectedActs((prev) => {
                            const next = new Set(prev)
                            for (const entry of visibleSummaryAccounts) next.add(entry.act)
                            return next
                          })
                          setAccountError(null)
                        }}
                        disabled={visibleSummaryAccounts.length === 0}
                        className="flex-1 rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
                      >
                        {t('boards.reading.picker.selectAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSummarySelectedActs((prev) => {
                            const next = new Set(prev)
                            for (const entry of visibleSummaryAccounts) next.delete(entry.act)
                            return next
                          })
                          setAccountError(null)
                        }}
                        disabled={summarySelectedActs.size === 0}
                        className="flex-1 rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
                      >
                        {t('boards.reading.picker.selectNone')}
                      </button>
                    </div>
                    <div
                      className={`text-right text-[11px] ${
                        summarySelectedActs.size > FB_READING_SUMMARY_ACCOUNT_LIMIT ? 'text-red-400' : 'text-cream-faint'
                      }`}
                    >
                      {t('boards.reading.accounts.selectedCount')
                        .replace('{n}', String(summarySelectedActs.size))
                        .replace('{max}', String(FB_READING_SUMMARY_ACCOUNT_LIMIT))}
                    </div>
                  </div>
                )}
                <div className="max-h-[132px] space-y-1 overflow-y-auto rounded-lg border border-line bg-ink-850/60 p-1.5">
                  {summaryFilterQuery !== '' && visibleSummaryAccounts.length === 0 && (
                    <div className="px-1.5 py-2 text-[11px] text-cream-faint">{t('boards.reading.accounts.searchNone')}</div>
                  )}
                  {visibleSummaryAccounts.map((entry) => {
                    const checked = summarySelectedActs.has(entry.act)
                    return (
                      <label key={entry.act} className="flex cursor-pointer items-center gap-2 text-[11px] text-cream-dim">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSummarySelectedActs((prev) => {
                              const next = new Set(prev)
                              if (checked) next.delete(entry.act)
                              else next.add(entry.act)
                              return next
                            })
                            setAccountError(null)
                          }}
                          className="accent-[rgb(var(--accent))]"
                        />
                        <span className="truncate">{entry.alias}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-cream-faint">{entry.act}</span>
                      </label>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setManageOpen((open) => !open)}
                  className="mt-1.5 w-full rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:text-cream"
                >
                  {t('boards.reading.accounts.manage')}
                </button>
              </Field>
            )}
            {accountError === 'none' && (
              <div className="text-[11px] text-red-400">{t('boards.reading.accounts.noneSelected')}</div>
            )}
            {accountError === 'limit' && (
              <div className="text-[11px] text-red-400">
                {t('boards.reading.accounts.tooMany').replace('{max}', String(FB_READING_SUMMARY_ACCOUNT_LIMIT))}
              </div>
            )}
            {readingMetricEmpty && (
              <div className="text-[11px] text-red-400">{t('boards.reading.needMetric')}</div>
            )}
            <FbReadingAccountManager
              open={manageOpen}
              accounts={accounts}
              onAccountsChange={handleReadingAccountsChange}
              onAccountsAdded={handleReadingAccountsAdded}
              onAccountsRemoved={handleReadingAccountsRemoved}
            />
            <PillField label={t('boards.reading.config.range')}>
              <div className="flex flex-wrap gap-1">
                {(['today', 'yesterday', 'last3', 'last7', 'last30'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setReadingRange(value)}
                      className={`focus-ring rounded-full border px-2.5 py-1 text-[12px] leading-[18px] transition ${
                        readingRange === value
                          ? 'border-accent/60 bg-accent-soft text-accent'
                          : 'border-line text-cream-dim hover:text-cream'
                      }`}
                    >
                      {fbReadingRangeLabel(t, value)}
                    </button>
                  ))}
              </div>
              <p className="mt-1 text-[12px] leading-[18px] tabular-nums text-cream-faint">
                {formatReadingWindow(boardReadingRangeDates(readingRange as FbReadingRange))}
              </p>
            </PillField>
            <PillField label={t('boards.reading.config.metrics')}>
              <div className="flex flex-wrap gap-1">
                {(['spend', 'balance', 'cpi', 'cpm', 'cpa', 'ctr'] as const).map((value) => {
                    const active = readingMetrics.includes(value)
                    return (
                      <button
                        key={value}
                        onClick={() => {
                          setReadingMetricEmpty(false)
                          setReadingMetrics((prev) =>
                            prev.includes(value) ? prev.filter((m) => m !== value) : [...prev, value]
                          )
                        }}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                          active
                            ? 'border-accent/60 bg-accent-soft text-accent'
                            : 'border-line text-cream-dim hover:text-cream'
                        }`}
                      >
                        {readingMetricLabel(value)}
                      </button>
                    )
                })}
              </div>
            </PillField>
          </>
        )}
        {widget.type === 'tt-reading' && (
          <>
            <Field label={t('boards.tt.config.advertiserIds')}>
              <input
                value={ttAdvertiserIds}
                onChange={(e) => setTtAdvertiserIds(e.target.value)}
                placeholder="7300000000000000000, 7311111111111111111"
                className={`${inputClass} font-mono`}
              />
            </Field>
            <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.tt.config.advertiserIdsHint')}</p>
            {(parseTikTokAdvertiserIdList(ttAdvertiserIds) === null || /[\x00-\x1f\x7f]/.test(ttAdvertiserIds) || (ttAdvertiserIds.trim() !== '' && parseTikTokAdvertiserIdList(ttAdvertiserIds)?.length === 0)) && <p role="alert" className="text-[12px] text-red-500">{t('boards.tt.invalidAdvertisers')}</p>}
            <PillField label={t('boards.reading.config.range')}>
              <div className="flex flex-wrap gap-1">
                {(['1', 'yd', '3', '7', '28', '30'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTtRange(value)}
                    className={`focus-ring rounded-full border px-2.5 py-1 text-[12px] leading-[18px] transition ${
                      ttRange === value
                        ? 'border-accent/60 bg-accent-soft text-accent'
                        : 'border-line text-cream-dim hover:text-cream'
                    }`}
                  >
                    {ttReadingRangeLabel(t, value)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[12px] leading-[18px] tabular-nums text-cream-faint">
                {formatReadingWindow(tiktokReadingRangeWindow(ttRange))}
              </p>
            </PillField>
          </>
        )}
        {widget.type === 'note' && (
          <Field label={t('boards.config.note')}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={BOARD_LIMITS.maxNoteLength}
              className={`${inputClass} resize-none leading-5`}
            />
          </Field>
        )}
        {supportsDataset && !datasetOnly && (
          <Field label={t('boards.config.source')}>
            <div className="flex rounded-lg border border-line bg-ink-850 p-0.5">
              {(['manual', 'dataset'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] transition ${
                    source === s ? 'bg-cream text-ink-950' : 'text-cream-dim hover:text-cream'
                  }`}
                >
                  {s === 'manual' ? t('boards.config.sourceManual') : t('boards.config.sourceDataset')}
                </button>
              ))}
            </div>
          </Field>
        )}
        {widget.type === 'gauge' && (
          <>
            <Field label={t('boards.config.value')}>
              <input
                value={numValue}
                onChange={(e) => setNumValue(e.target.value)}
                inputMode="decimal"
                placeholder="0 – 100"
                className={inputClass}
              />
            </Field>
            <Field label={t('boards.config.label')}>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={BOARD_LIMITS.maxLabelLength}
                className={inputClass}
              />
            </Field>
          </>
        )}
        {widget.type === 'counter' && source === 'manual' && (
          <Field label={t('boards.config.value')}>
            <input
              value={numValue}
              onChange={(e) => setNumValue(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className={inputClass}
            />
          </Field>
        )}
        {widget.type === 'counter' && (
          <Field label={t('boards.config.label')}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={BOARD_LIMITS.maxLabelLength}
              className={inputClass}
            />
          </Field>
        )}
        {isChart && (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-cream-dim">
            <input
              type="checkbox"
              checked={showValues}
              onChange={(e) => setShowValues(e.target.checked)}
              className="accent-[rgb(var(--accent))]"
            />
            {t('boards.config.showValues')}
          </label>
        )}
        {isChart && source === 'manual' && (
          <>
            <Field label={t('boards.config.points')}>
              <input
                value={pointsText}
                onChange={(e) => setPointsText(e.target.value)}
                placeholder="3, 5, 4, 7, 6"
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label={t('boards.config.labels')}>
              <input
                value={labelsText}
                onChange={(e) => {
                  setLabelsText(e.target.value)
                  setLabelsInvalid(false)
                }}
                className={inputClass}
              />
              {labelsInvalid && (
                <p className="mt-1 text-[10.5px] leading-4 text-red-500">{t('boards.config.labelsTooLong')}</p>
              )}
            </Field>
          </>
        )}
        {supportsDataset && source === 'dataset' && (
          <>
            {datasets.length === 0 ? (
              <p className="text-[11px] leading-4 text-cream-faint">
                {t('boards.config.noDatasets')}
              </p>
            ) : (
              <>
                <Field label={t('boards.config.dataset')}>
                  <select
                    value={datasetId}
                    onChange={(e) => {
                      setDatasetId(e.target.value)
                      setMetric('')
                      setDimension('')
                      setTableColumns((datasets.find(dataset => dataset.id === e.target.value)?.columns ?? []).slice(0, 8).map(column => column.name))
                      setSortColumn('')
                    }}
                    className={inputClass}
                  >
                    <option value="">{t('boards.config.pickDataset')}</option>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {widget.type !== 'table' && <><Field label={t('boards.config.metric')}>
                  <select
                    value={metric}
                    onChange={(e) => setMetric(e.target.value)}
                    disabled={!selectedDataset}
                    className={inputClass}
                  >
                    <option value="">{t('boards.config.pickColumn')}</option>
                    {metricColumns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('boards.config.op')}>
                  <select
                    value={op}
                    onChange={(e) => setOp(e.target.value as DatasetOp)}
                    className={inputClass}
                  >
                    {DATASET_OPS.map((o) => (
                      <option key={o} value={o}>
                        {t(`boards.config.op.${o}` as I18nKey)}
                      </option>
                    ))}
                  </select>
                </Field></>}
                {(isChart || widget.type === 'analysis') && (
                  <Field label={t('boards.config.dimension')}>
                    <select
                      value={dimension}
                      onChange={(e) => setDimension(e.target.value)}
                      disabled={!selectedDataset}
                      className={inputClass}
                    >
                      <option value="">{t('boards.config.pickColumn')}</option>
                      {(selectedDataset?.columns ?? []).map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {widget.type === 'table' && selectedDataset && <>
                  <PillField label={t('boards.table.columns')}>
                    <div className="grid grid-cols-2 gap-1 rounded-lg border border-line p-2">{selectedDataset.columns.map(column => <label key={column.name} className="flex min-w-0 items-center gap-1.5 text-[11px] text-cream-dim"><input type="checkbox" checked={tableColumns.includes(column.name)} disabled={!tableColumns.includes(column.name) && tableColumns.length >= 12} onChange={event => setTableColumns(current => event.target.checked ? [...current, column.name] : current.filter(name => name !== column.name))} /><span className="truncate" title={column.name}>{column.name}</span></label>)}</div>
                  </PillField>
                  <div className="grid grid-cols-2 gap-2"><Field label={t('boards.table.pageSize')}><select value={pageSize} onChange={event => setPageSize(Number(event.target.value))} className={inputClass}>{[5, 10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></Field><Field label={t('boards.table.sortColumn')}><select value={sortColumn} onChange={event => setSortColumn(event.target.value)} className={inputClass}><option value="">—</option>{selectedDataset.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select></Field></div>
                  {sortColumn && <Field label={t('boards.table.sortDirection')}><select value={sortDirection} onChange={event => setSortDirection(event.target.value as 'asc' | 'desc')} className={inputClass}><option value="asc">{t('boards.table.ascending')}</option><option value="desc">{t('boards.table.descending')}</option></select></Field>}
                </>}
              </>
            )}
          </>
        )}
        {widget.type === 'funnel' && <div className="space-y-2">
          {funnelStages.map((stage, index) => {
            const dataset = datasets.find(item => item.id === stage.datasetId || item.name === stage.datasetId)
            const update = (patch: Partial<FunnelStage>) => setFunnelStages(current => current.map((item, at) => at === index ? { ...item, ...patch } : item))
            return <fieldset key={index} className="space-y-1.5 rounded-lg border border-line p-2"><legend className="px-1 text-[11px] font-medium text-cream-dim">{t('boards.funnel.stage', { n: String(index + 1) })}</legend>
              <div className="flex items-end gap-1"><div className="min-w-0 flex-1"><Field label={t('boards.funnel.stageLabel')}><input value={stage.label} maxLength={100} onChange={event => update({ label: event.target.value })} className={inputClass} /></Field></div><button type="button" aria-label={t('boards.funnel.removeStage')} disabled={funnelStages.length <= 2} onClick={() => setFunnelStages(current => current.filter((_item, at) => at !== index))} className="focus-ring rounded p-1 text-cream-faint disabled:opacity-30"><X size={13} /></button></div>
              <Field label={t('boards.config.dataset')}><select value={stage.datasetId} onChange={event => update({ datasetId: event.target.value, metric: '' })} className={inputClass}><option value="">{t('boards.config.pickDataset')}</option>{datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
              <div className="grid grid-cols-2 gap-2"><Field label={t('boards.config.metric')}><select value={stage.metric} onChange={event => update({ metric: event.target.value })} className={inputClass}><option value="">{t('boards.config.pickColumn')}</option>{(dataset?.columns ?? []).filter(column => column.type === 'number').map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select></Field><Field label={t('boards.config.op')}><select value={stage.op} onChange={event => update({ op: event.target.value as DatasetOp })} className={inputClass}>{DATASET_OPS.map(value => <option key={value} value={value}>{t(`boards.config.op.${value}` as I18nKey)}</option>)}</select></Field></div>
              {stage.filterColumn && <p className="break-words text-[10px] text-cream-faint">{stage.filterColumn}: {(stage.filterValues ?? [stage.filterValue ?? '']).join(', ')}</p>}
            </fieldset>
          })}
          <button type="button" disabled={funnelStages.length >= 12} onClick={() => setFunnelStages(current => [...current, { source: 'dataset', label: '', datasetId: '', metric: '', op: 'sum' }])} className="focus-ring w-full rounded-lg border border-line px-2 py-1.5 text-[12px] text-cream-dim hover:bg-overlay disabled:opacity-40">{t('boards.funnel.addStage')}</button>
        </div>}
        {widget.type === 'todo' && (
          <p className="text-[11px] leading-4 text-cream-faint">{t('boards.config.todoHint')}</p>
        )}
        {widget.type === 'link' && (
          <Field label={t('boards.config.url')}>
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setUrlInvalid(false)
              }}
              placeholder="https://…"
              className={`${inputClass} font-mono`}
            />
          </Field>
        )}
        {widget.type === 'google-report-reading' && (
          <>
            <Field label={t('boards.googleReport.config.url')}>
              <textarea
                value={googleReportUrl}
                onChange={(event) => { setGoogleReportUrl(event.target.value); setGoogleUrlInvalid(false) }}
                placeholder="https://ads.google.com/aw/campaigns?…"
                rows={3}
                className={`${inputClass} resize-y break-all`}
              />
            </Field>
            <p className="text-[11px] leading-4 text-cream-faint">{t('boards.googleReport.config.hint')}</p>
            {googleUrlInvalid && <p role="alert" className="text-[11px] text-red-500">{t('boards.googleReport.invalidUrl')}</p>}
          </>
        )}
        {widget.type === 'fb-report-reading' && (
          <p className="text-xs text-cream-faint">{t('boards.fbReport.products.configHint')}</p>
        )}
        {widget.type === 'file' && (
          <>
            <Field label={t('boards.config.file')}>
              <div className="truncate rounded-lg border border-line bg-ink-850 px-2 py-1 font-mono text-[11px] text-cream-dim" title={boundPath || undefined}>
                {boundPath || t('boards.config.noFile')}
              </div>
            </Field>
            <button
              onClick={() => void pickFile()}
              disabled={!currentWorkspace || pickBusy}
              title={!currentWorkspace ? t('boards.files.noWorkspace') : undefined}
              className="flex items-center justify-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FilePlus2 size={12} />
              {pickBusy ? t('app.loading') : t('boards.config.pickFile')}
            </button>
            {!currentWorkspace && <p className="text-[10.5px] leading-4 text-cream-faint">{t('boards.files.noWorkspace')}</p>}
            {pickError && <p className="text-[10.5px] leading-4 text-red-500">{t(pickError)}</p>}
            <p className="text-[10.5px] leading-4 text-cream-faint">{t('boards.config.fileHint')}</p>
          </>
        )}
        {urlInvalid && <p className="text-[10.5px] leading-4 text-red-500">{t('boards.config.invalidUrl')}</p>}
        <div className="border-t border-line pt-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-cream-faint">{t('boards.appearance.title')}</span>
            <button
              onClick={() => setStyle({})}
              className="rounded px-1 py-0.5 text-[10px] text-cream-faint transition hover:bg-overlay hover:text-cream"
            >
              {t('boards.appearance.reset')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['accent', 'boards.appearance.accent', '#d97757'],
                ['surface', 'boards.appearance.surface', '#1d1c1a'],
                ['text', 'boards.appearance.text', '#ebe7e4'],
                ['border', 'boards.appearance.border', '#625d57']
              ] as const
            ).map(([key, labelKey, fallback]) => (
              <label key={key} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-line bg-ink-850 px-1.5 py-1">
                <input
                  type="color"
                  value={style[key] ?? fallback}
                  onChange={(event) => setStyleColor(key, event.target.value)}
                  aria-label={t(labelKey)}
                  className="h-5 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span className="truncate text-[10.5px] text-cream-dim">{t(labelKey)}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label={t('boards.appearance.radius')}>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="32"
                  value={style.radius ?? 16}
                  onChange={(event) => setStyle((current) => ({ ...current, radius: Number(event.target.value) }))}
                  className="min-w-0 flex-1 accent-[rgb(var(--accent))]"
                />
                <span className="w-5 text-right font-mono text-[10px] text-cream-faint">{style.radius ?? 16}</span>
              </div>
            </Field>
            <Field label={t('boards.appearance.padding')}>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="6"
                  max="32"
                  value={style.padding ?? 12}
                  onChange={(event) => setStyle((current) => ({ ...current, padding: Number(event.target.value) }))}
                  className="min-w-0 flex-1 accent-[rgb(var(--accent))]"
                />
                <span className="w-5 text-right font-mono text-[10px] text-cream-faint">{style.padding ?? 12}</span>
              </div>
            </Field>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label={t('boards.appearance.titleAlign')}>
              <select
                value={style.titleAlign ?? 'left'}
                onChange={(event) =>
                  setStyle((current) => ({
                    ...current,
                    titleAlign: event.target.value as BoardWidgetStyle['titleAlign']
                  }))
                }
                className={inputClass}
              >
                <option value="left">{t('boards.appearance.align.left')}</option>
                <option value="center">{t('boards.appearance.align.center')}</option>
                <option value="right">{t('boards.appearance.align.right')}</option>
              </select>
            </Field>
            <Field label={t('boards.appearance.shadow')}>
              <select
                value={style.shadow ?? 'soft'}
                onChange={(event) =>
                  setStyle((current) => ({
                    ...current,
                    shadow: event.target.value as BoardWidgetStyle['shadow']
                  }))
                }
                className={inputClass}
              >
                <option value="none">{t('boards.appearance.shadow.none')}</option>
                <option value="soft">{t('boards.appearance.shadow.soft')}</option>
                <option value="strong">{t('boards.appearance.shadow.strong')}</option>
              </select>
            </Field>
          </div>
        </div>
      </div>
      <div className="mt-2 flex shrink-0 justify-end gap-1.5">
        <button
          onClick={onClose}
          disabled={saveBusy}
          className="rounded-full border border-line px-2.5 py-1 text-[11px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
        >
          {t('boards.cancel')}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={saveBusy || datasetIncomplete || (widget.type === 'tt-reading' && (parseTikTokAdvertiserIdList(ttAdvertiserIds) === null || /[\x00-\x1f\x7f]/.test(ttAdvertiserIds) || (ttAdvertiserIds.trim() !== '' && parseTikTokAdvertiserIdList(ttAdvertiserIds)?.length === 0)))}
          className="flex items-center gap-1 rounded-full bg-cream px-2.5 py-1 text-[11px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
        >
          <Check size={10} />
          {t('boards.save')}
        </button>
      </div>
    </div>
  )
}
