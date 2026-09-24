import { useMemo, useState } from 'react'
import { Check, FilePlus2, X } from 'lucide-react'
import { BoardDataset, BoardWidget, BoardWidgetStyle } from '@shared/types'
import { BOARD_LIMITS, isValidLinkUrl } from '@shared/boards'
import { DATASET_OPS, DatasetOp } from '@shared/datasets'
import { FB_READING_SUMMARY_ACCOUNT_LIMIT, resolveFbReadingSummaryAccounts, resolveFbReadingWidgetAccount } from '@shared/fbReading'
import type { FbReadingAccountEntry } from '@shared/fbReading'
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
  datasets: BoardDataset[]
  onClose: () => void
  onSave: (patch: { title: string; config: Record<string, unknown>; style?: BoardWidgetStyle }) => void
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

function configString(widget: BoardWidget, key: string): string {
  const value = widget.config[key]
  return typeof value === 'string' ? value : ''
}

export function WidgetConfigPanel({ widget, datasets, onClose, onSave }: WidgetConfigPanelProps) {
  const t = useT()
  const [title, setTitle] = useState(widget.title)
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
  const [labelsInvalid, setLabelsInvalid] = useState(false)
  const [style, setStyle] = useState<BoardWidgetStyle>(widget.style ?? {})

  // File widget binding: the native picker returns a workspace-RELATIVE path
  // from Main (validated against the active workspace grant). Drafted here
  // like every other field; committed on Save through the normal board write.
  const currentWorkspace = useAppStore((state) => state.currentWorkspace)
  const [boundPath, setBoundPath] = useState(configString(widget, 'filePath'))
  const [pickBusy, setPickBusy] = useState(false)
  const [pickError, setPickError] = useState<I18nKey | null>(null)

  // FB reading module: pinned account + date window + metric set.
  const [readingRange, setReadingRange] = useState(
    widget.config.range === 'today' || widget.config.range === 'last3' || widget.config.range === 'last30'
      ? (widget.config.range as 'today' | 'last3' | 'last30')
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
  const [ttRange, setTtRange] = useState<'1' | '7' | '28'>(
    widget.config.range === '1' || widget.config.range === '28'
      ? (widget.config.range as '1' | '28')
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
    setSelectedAct((prev) => (entries.some((entry) => entry.act === prev) ? prev : entries[0]?.act ?? ''))
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

  const readingMetricLabel = (value: string): string => {
    if (value === 'spend') return t('boards.reading.summary.metric.spend')
    if (value === 'balance') return t('boards.reading.balance.label')
    if (value === 'cpi') return t('boards.reading.summary.metric.cpi')
    if (value === 'cpm') return t('boards.reading.summary.metric.cpm')
    if (value === 'cpa') return t('boards.reading.summary.metric.cpa')
    return t('boards.reading.summary.metric.ctr')
  }

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

  // Dataset binding (counter / chart-line / chart-bar only).
  const supportsDataset =
    widget.type === 'counter' || widget.type === 'chart-line' || widget.type === 'chart-bar'
  const isChart = widget.type === 'chart-line' || widget.type === 'chart-bar'
  const [source, setSource] = useState<'manual' | 'dataset'>(
    widget.config.source === 'dataset' ? 'dataset' : 'manual'
  )
  const [datasetId, setDatasetId] = useState(configString(widget, 'datasetId'))
  const [metric, setMetric] = useState(configString(widget, 'metric'))
  const [op, setOp] = useState<DatasetOp>(() =>
    (DATASET_OPS as readonly string[]).includes(widget.config.op as string)
      ? (widget.config.op as DatasetOp)
      : 'sum'
  )
  const [dimension, setDimension] = useState(configString(widget, 'dimension'))

  const setStyleColor = (key: 'accent' | 'surface' | 'text' | 'border', value: string) => {
    setStyle((current) => ({ ...current, [key]: value }))
  }

  const selectedDataset = datasets.find((d) => d.id === datasetId)
  const metricColumns = (selectedDataset?.columns ?? []).filter((c) => c.type === 'number')
  const datasetIncomplete =
    supportsDataset && source === 'dataset' && (!datasetId || !metric || (isChart && !dimension))

  /** Dataset fields kept alongside the manual ones so toggling loses nothing. */
  const bindingConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = { source, op }
    if (datasetId) config.datasetId = datasetId
    if (metric) config.metric = metric
    if (isChart && dimension) config.dimension = dimension
    return config
  }

  const handleSave = () => {
    if (datasetIncomplete) return
    let config: Record<string, unknown>
    switch (widget.type) {
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
      case 'tt-reading':
        // Empty advertiserIds is valid: the token's own grant covers all.
        config = { advertiserIds: ttAdvertiserIds.slice(0, 400), range: ttRange }
        break
    }
    onSave({
      title: title.trim() || widget.title,
      config,
      ...(Object.keys(style).length > 0 ? { style } : {})
    })
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
                    {accounts.length === 0 && <option value="">{t('boards.reading.accounts.loading')}</option>}
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
            <Field label={t('boards.reading.config.range')}>
              <div className="flex flex-wrap gap-1">
                {([['today', '今天'], ['last3', '近3天'], ['last7', '近7天'], ['last30', '近30天']] as const).map(
                  ([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setReadingRange(value)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                        readingRange === value
                          ? 'border-accent/60 bg-accent-soft text-accent'
                          : 'border-line text-cream-dim hover:text-cream'
                      }`}
                    >
                      {label}
                    </button>
                  )
                )}
              </div>
            </Field>
            <Field label={t('boards.reading.config.metrics')}>
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
            </Field>
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
            <p className="text-[10.5px] leading-4 text-cream-faint">{t('boards.tt.config.advertiserIdsHint')}</p>
            <Field label={t('boards.reading.config.range')}>
              <div className="flex flex-wrap gap-1">
                {([['1', '今天'], ['7', '近7天'], ['28', '近28天']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setTtRange(value)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                      ttRange === value
                        ? 'border-accent/60 bg-accent-soft text-accent'
                        : 'border-line text-cream-dim hover:text-cream'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
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
        {supportsDataset && (
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
                <Field label={t('boards.config.metric')}>
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
                </Field>
                {isChart && (
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
              </>
            )}
          </>
        )}
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
          className="rounded-full border border-line px-2.5 py-1 text-[11px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
        >
          {t('boards.cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={datasetIncomplete}
          className="flex items-center gap-1 rounded-full bg-cream px-2.5 py-1 text-[11px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
        >
          <Check size={10} />
          {t('boards.save')}
        </button>
      </div>
    </div>
  )
}
