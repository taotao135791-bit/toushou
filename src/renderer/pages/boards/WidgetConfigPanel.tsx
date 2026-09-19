import { useEffect, useMemo, useState } from 'react'
import { Check, FilePlus2, X } from 'lucide-react'
import { BoardDataset, BoardWidget, BoardWidgetStyle } from '@shared/types'
import { BOARD_LIMITS, isValidLinkUrl } from '@shared/boards'
import { DATASET_OPS, DatasetOp } from '@shared/datasets'
import { resolveFbReadingSummaryAccounts, resolveFbReadingWidgetAccount } from '@shared/fbReading'
import type { FbReadingAccountEntry } from '@shared/fbReading'
import { useAppStore } from '../../store'
import { useT, I18nKey } from '../../i18n'

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
  const [formAlias, setFormAlias] = useState('')
  const [formAct, setFormAct] = useState('')
  const [formBusinessId, setFormBusinessId] = useState('')
  const [accountError, setAccountError] = useState<'invalid' | 'none' | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [discovered, setDiscovered] = useState<Array<{ name: string; act: string }> | null>(null)
  const [discoverFailed, setDiscoverFailed] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [summarySelectedActs, setSummarySelectedActs] = useState<Set<string>>(
    () => new Set(resolveFbReadingSummaryAccounts(widget.config).map((account) => account.act))
  )
  const [readingMetricEmpty, setReadingMetricEmpty] = useState(false)

  const summaryAccountOptions = useMemo(() => {
    const merged = new Map<string, FbReadingAccountEntry>()
    for (const account of resolveFbReadingSummaryAccounts(widget.config)) {
      merged.set(account.act, { ...account, id: account.act, createdAt: 0 })
    }
    for (const account of accounts) merged.set(account.act, account)
    return Array.from(merged.values())
  }, [accounts, widget.config])

  useEffect(() => {
    if (widget.type !== 'fb-reading' && widget.type !== 'fb-reading-summary') return
    let alive = true
    void window.electronAPI
      .listFbReadingAccounts()
      .then((list) => {
        if (!alive) return
        const entries = Array.isArray(list) ? list : []
        setAccounts(entries)
        setSelectedAct((prev) => prev || entries[0]?.act || '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [widget.type])

  const selectedAccount = accounts.find((entry) => entry.act === selectedAct) ?? null

  const addAccount = async () => {
    const alias = formAlias.trim()
    const act = formAct.trim()
    const businessId = formBusinessId.trim()
    if (!alias || !/^\d{6,20}$/.test(act) || (businessId !== '' && !/^\d{6,20}$/.test(businessId))) {
      setAccountError('invalid')
      return
    }
    setAccountBusy(true)
    setAccountError(null)
    try {
      const result = await window.electronAPI.addFbReadingAccounts({
        accounts: [{ alias, act, businessId: businessId === '' ? null : businessId }]
      })
      if (!result.ok || !result.accounts) {
        setAccountError('invalid')
        return
      }
      setAccounts(result.accounts)
      setSelectedAct(act)
      setFormAlias('')
      setFormAct('')
      setFormBusinessId('')
    } catch {
      setAccountError('invalid')
    } finally {
      setAccountBusy(false)
    }
  }

  const removeAccount = async (id: string) => {
    try {
      const result = await window.electronAPI.removeFbReadingAccount({ id })
      if (result.ok && result.accounts) {
        const entries = result.accounts
        setAccounts(entries)
        setSelectedAct((prev) => (entries.some((entry) => entry.act === prev) ? prev : entries[0]?.act ?? ''))
      }
    } catch {
      // Removal is best-effort; the list refresh below shows current state.
    }
  }

  const discover = async () => {
    setDiscoverBusy(true)
    setDiscovered(null)
    setDiscoverFailed(false)
    setDiscoverError(null)
    try {
      const result = await window.electronAPI.discoverFbReadingAccounts({ query: discoverQuery.trim() })
      if (result.ok && result.accounts && result.accounts.length > 0) {
        setDiscovered(result.accounts)
      } else {
        setDiscoverFailed(true)
        setDiscoverError(result.error ?? 'unknown')
      }
    } catch {
      setDiscoverFailed(true)
      setDiscoverError('invoke-failed')
    } finally {
      setDiscoverBusy(false)
    }
  }

  const addDiscovered = async (entry: { name: string; act: string }) => {
    if (accounts.some((account) => account.act === entry.act)) return
    setAccountBusy(true)
    try {
      const result = await window.electronAPI.addFbReadingAccounts({
        accounts: [{ alias: entry.name, act: entry.act, businessId: null }]
      })
      if (result.ok && result.accounts) {
        setAccounts(result.accounts)
        setSelectedAct(entry.act)
      }
    } catch {
      // Keep the discovered list; the user can retry or add manually.
    } finally {
      setAccountBusy(false)
    }
  }

  const captureFromPanel = async () => {
    setDiscoverFailed(false)
    setDiscoverError(null)
    try {
      const result = await window.electronAPI.captureFbReadingAccount()
      if (!result.ok || !result.account) {
        setDiscoverFailed(true)
        setDiscoverError(result.error ?? 'unknown')
        return
      }
      setFormAct(result.account.act)
      setFormBusinessId(result.account.businessId ?? '')
    } catch {
      setDiscoverFailed(true)
      setDiscoverError('invoke-failed')
    }
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
        config = { points, labels, ...bindingConfig() }
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
                <div className="max-h-[132px] space-y-1 overflow-y-auto rounded-lg border border-line bg-ink-850/60 p-1.5">
                  {summaryAccountOptions.map((entry) => {
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
              </Field>
            )}
            {accountError === 'none' && (
              <div className="text-[11px] text-red-400">{t('boards.reading.accounts.noneSelected')}</div>
            )}
            {readingMetricEmpty && (
              <div className="text-[11px] text-red-400">{t('boards.reading.needMetric')}</div>
            )}
            {manageOpen && (
              <div className="space-y-2 rounded-xl border border-line bg-ink-850/60 p-2">
                {accounts.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 text-[11px] text-cream-dim">
                    <span className="truncate">
                      {entry.alias} · {entry.act}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeAccount(entry.id)}
                      className="shrink-0 text-cream-faint transition hover:text-red-400"
                    >
                      {t('boards.reading.accounts.remove')}
                    </button>
                  </div>
                ))}
                <div className="space-y-1.5 border-t border-line pt-2">
                  <input
                    value={discoverQuery}
                    onChange={(e) => setDiscoverQuery(e.target.value)}
                    maxLength={30}
                    placeholder={t('boards.reading.accounts.query')}
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => void discover()}
                    disabled={discoverBusy}
                    className="w-full rounded-lg border border-line px-2 py-1 text-[11px] text-cream-dim transition hover:text-cream disabled:opacity-40"
                  >
                    {discoverBusy ? t('boards.reading.accounts.discovering') : t('boards.reading.accounts.discover')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void captureFromPanel()}
                    className="w-full rounded-lg border border-accent/50 px-2 py-1 text-[11px] text-accent transition hover:opacity-80"
                  >
                    {t('boards.reading.accounts.capture')}
                  </button>
                  {discoverFailed && (
                    <div className="text-[11px] text-red-400">
                      {t('boards.reading.accounts.discoverFailed')} ({discoverError ?? 'unknown'})
                    </div>
                  )}
                  {discovered && discovered.length === 0 && (
                    <div className="text-[11px] text-cream-faint">{t('boards.reading.accounts.discoveredNone')}</div>
                  )}
                  {discovered && discovered.length > 0 && (
                    <div className="max-h-[120px] space-y-0.5 overflow-y-auto">
                      {discovered.map((entry) => {
                        const exists = accounts.some((account) => account.act === entry.act)
                        return (
                          <div key={entry.act} className="flex items-center justify-between gap-2 text-[11px] text-cream-dim">
                            <span className="truncate">{entry.name} · {entry.act}</span>
                            <button
                              type="button"
                              onClick={() => void addDiscovered(entry)}
                              disabled={exists || accountBusy}
                              className="shrink-0 text-accent transition hover:opacity-80 disabled:opacity-40"
                            >
                              {exists ? t('boards.reading.accounts.exists') : t('boards.reading.accounts.addShort')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <input
                    value={formAlias}
                    onChange={(e) => setFormAlias(e.target.value)}
                    maxLength={40}
                    placeholder={t('boards.reading.accounts.alias')}
                    className={inputClass}
                  />
                  <input
                    value={formAct}
                    onChange={(e) => setFormAct(e.target.value)}
                    inputMode="numeric"
                    placeholder={t('boards.reading.accounts.act')}
                    className={inputClass}
                  />
                  <input
                    value={formBusinessId}
                    onChange={(e) => setFormBusinessId(e.target.value)}
                    inputMode="numeric"
                    placeholder={t('boards.reading.accounts.businessId')}
                    className={inputClass}
                  />
                  {accountError === 'invalid' && (
                    <div className="text-[11px] text-red-400">{t('boards.reading.accounts.invalid')}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => void addAccount()}
                    disabled={accountBusy}
                    className="w-full rounded-lg border border-accent/50 bg-accent-soft px-2 py-1 text-[11px] text-accent transition hover:opacity-80 disabled:opacity-40"
                  >
                    {t('boards.reading.accounts.add')}
                  </button>
                </div>
              </div>
            )}
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
                {([['spend', '消耗'], ['cpi', 'CPI'], ['cpm', 'CPM'], ['cpa', 'CPA'], ['ctr', 'CTR']] as const).map(
                  ([value, label]) => {
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
                        {label}
                      </button>
                    )
                  }
                )}
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
