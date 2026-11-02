import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import type {
  FbReportAutoFetchResult,
  FbReportIssue,
  FbReportStoredReading
} from '@shared/fbReportCsv'
import { fbReportReadingEvidence } from '@shared/readingEvidence'
import { ReadingEvidenceLine } from './ReadingEvidenceLine'
import { useT } from '../../i18n'
import { selectedFbReportProduct } from '@shared/fbReportProducts'
import { FbReportProductSelector } from './FbReportProductSelector'

const fmtMoney = (value: number | null): string => (value === null ? '—' : value.toFixed(2))
const fmtCount = (value: number | null): string => (value === null ? '—' : String(Math.round(value)))
const fmtRate = (value: number | null): string => (value === null ? '—' : value.toFixed(2))

const CANONICAL_LABELS: Record<string, string> = {
  spend: 'boards.fbReport.colSpend',
  impressions: 'boards.fbReport.colImpressions',
  clicks: 'boards.fbReport.colClicks',
  installs: 'boards.fbReport.colInstalls',
  purchases: 'boards.fbReport.colPurchases'
}

function fatalText(t: ReturnType<typeof useT>, issue: FbReportIssue): string {
  switch (issue.code) {
    case 'missing-totals-row':
      return t('boards.fbReport.fatalMissingTotals')
    case 'ambiguous-totals':
      return t('boards.fbReport.fatalAmbiguousTotals')
    case 'missing-account-column':
      return t('boards.fbReport.fatalMissingColumn') + t('boards.fbReport.colAccount')
    case 'missing-spend-column':
      return t('boards.fbReport.fatalMissingColumn') + t('boards.fbReport.colSpend')
    case 'missing-date-columns':
      return t('boards.fbReport.fatalMissingDate')
    case 'window-inconsistent':
      return t('boards.fbReport.fatalWindow')
    case 'sum-mismatch':
    case 'totals-value-missing':
      return (
        t('boards.fbReport.fatalSumMismatch') +
        (issue.column ?? '') +
        (issue.code === 'sum-mismatch' ? ' (' + (issue.expected ?? '?') + ' ≠ ' + (issue.actual ?? '?') + ')' : '')
      )
    default:
      return issue.code
  }
}

function fetchErrorText(t: ReturnType<typeof useT>, code: string, detail?: string): string {
  const keys: Record<string, string> = {
    'panel-not-open': 'boards.fbReport.fetch.panelNotOpen',
    'navigation-failed': 'boards.fbReport.fetch.navigationFailed',
    'login-required': 'boards.fbReport.fetch.loginRequired',
    'report-not-found': 'boards.fbReport.fetch.reportNotFound',
    'export-button-not-found': 'boards.fbReport.fetch.exportButtonNotFound',
    'csv-option-not-found': 'boards.fbReport.fetch.csvOptionNotFound',
    'download-timeout': 'boards.fbReport.fetch.downloadTimeout',
    'download-failed': 'boards.fbReport.fetch.downloadFailed',
    'fetch-failed': 'boards.fbReport.fetch.failed'
  }
  const base = t((keys[code] ?? 'boards.fbReport.fetch.failed') as never)
  return detail ? base + ' — ' + detail : base
}

/** Switching products reads local verified data only; exporting requires an explicit refresh. */
export function FbReportReadingBody({ widget, onConfigChange }: {
  widget: BoardWidget
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const t = useT()
  const product = selectedFbReportProduct(widget.config, widget.id)
  const readingId = product?.id ?? ''
  const loadVersion = useRef(0)
  const activeId = useRef(readingId)
  activeId.current = readingId
  const [stored, setStored] = useState<{ id: string; reading: FbReportStoredReading | null } | null>(null)
  const reading = stored?.id === readingId ? stored.reading : null
  const [busy, setBusy] = useState(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const [rejected, setRejected] = useState<FbReportIssue[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const reportName = product?.reportName ?? ''
  const reportId = product?.reportId ?? ''
  const range = typeof widget.config.range === 'string' ? widget.config.range : ''
  // Main marks unsupported master presets independent and retains the old range.
  // Do not export that old range after the user has chosen yesterday / last3.
  const dateUnavailable = widget.config.independent === true || !['today', 'last7', 'last30'].includes(range)

  useEffect(() => {
    let canceled = false
    const version = ++loadVersion.current
    setRejected(null)
    setUnavailable(false)
    setFetchError(null)
    if (readingId) {
      void window.electronAPI.fbReportReadingGet(readingId).then((value) => {
        if (!canceled && version === loadVersion.current) setStored({ id: readingId, reading: value })
      }).catch(() => { if (!canceled) setUnavailable(true) })
    }
    return () => { canceled = true }
  }, [readingId])

  const runAutoFetch = useCallback((): Promise<void> => {
    // Both the module button and refresh-all share one operation, even on rapid clicks.
    if (inFlight.current) return inFlight.current
    if (!readingId || !reportName || dateUnavailable) return Promise.resolve()
    ++loadVersion.current
    setBusy(true)
    setRejected(null)
    setUnavailable(false)
    setFetchError(null)
    const task = Promise.resolve().then(async () => {
      try {
        const result: FbReportAutoFetchResult = await window.electronAPI.fbReportAutoFetch(readingId, reportName, reportId || undefined, range || undefined)
        if (activeId.current !== readingId) return
        if (result.fetchError) setFetchError(fetchErrorText(t, result.fetchError, result.detail))
        else if (result.ok && result.outcome && !result.outcome.verification.verified) setRejected(result.outcome.verification.fatal)
        else if (!result.ok) setUnavailable(true)
        const value = await window.electronAPI.fbReportReadingGet(readingId)
        if (activeId.current === readingId) setStored({ id: readingId, reading: value })
      } catch {
        if (activeId.current === readingId) setUnavailable(true)
      } finally {
        setBusy(false)
        inFlight.current = null
      }
    })
    inFlight.current = task
    return task
  }, [readingId, reportName, reportId, range, dateUnavailable, t])

  useEffect(() => {
    const onRefresh = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { widgetId?: string }
      if (detail?.widgetId !== widget.id) return
      void runAutoFetch().finally(() => {
        window.dispatchEvent(new CustomEvent('fb-report-reading:module-done', { detail: { widgetId: widget.id } }))
      })
    }
    window.addEventListener('fb-report-reading:board-refresh', onRefresh)
    return () => window.removeEventListener('fb-report-reading:board-refresh', onRefresh)
  }, [widget.id, runAutoFetch])

  const summary = reading?.summary ?? null
  // Dynamic columns: every metric the file actually had, in file order.
  const metricCols = summary?.metrics ?? []
  const th = 'px-2 py-1 text-left font-medium text-neutral-500'
  const td = 'px-2 py-1 tabular-nums'

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
      <FbReportProductSelector widget={widget} disabled={busy} onConfigChange={onConfigChange} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void runAutoFetch()}
          disabled={busy || !reportName || dateUnavailable}
          title={reportName ? undefined : t('boards.fbReport.products.choose')}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50 disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden="true" />
          {busy ? t('boards.fbReport.autoFetching') : t('boards.fbReport.autoFetch')}
        </button>
        {summary && (
          <span className="text-neutral-500">
            {t('boards.fbReport.window')}: {summary.windowStart ?? '—'} – {summary.windowEnd ?? '—'}
            {summary.currency ? ' · ' + summary.currency : ''}
            {summary.attribution ? ' · ' + summary.attribution : ''} · {reading?.fileName}
          </span>
        )}
      </div>

      {unavailable && <p className="text-red-600">{t('boards.fbReport.unavailable')}</p>}
      {fetchError && <p className="text-red-600">{fetchError}</p>}
      {dateUnavailable && (
        <p className="text-neutral-400">{t('boards.fbReport.rangeHint')}</p>
      )}
      {rejected && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">
          <p className="font-medium">{t('boards.fbReport.rejected')}</p>
          <ul className="mt-1 list-disc pl-4">
            {rejected.map((issue, index) => (
              <li key={index}>{fatalText(t, issue)}</li>
            ))}
          </ul>
        </div>
      )}

      {product && <p className="text-neutral-500">{t('boards.fbReport.products.report')}: {product.reportName}</p>}
      {!product && <p className="text-neutral-500">{t('boards.fbReport.products.first')}</p>}
      {summary ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <p className="text-neutral-500">{t('boards.fbReport.products.cached')}</p>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className={th}>{t('boards.fbReport.colAccount')}</th>
                {metricCols.map((col) => (
                  <th key={col.header} className={th}>
                    {col.semantic && CANONICAL_LABELS[col.semantic]
                      ? t(CANONICAL_LABELS[col.semantic] as Parameters<typeof t>[0])
                      : col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.accounts.map((row) => (
                <tr key={row.account} className="border-b border-neutral-100">
                  <td className={td}>{row.account}</td>
                  {metricCols.map((col) => {
                    const value = row.metrics?.[col.header] ?? null
                    return (
                      <td key={col.header} className={td}>
                        {col.kind === 'money' ? fmtMoney(value) : col.kind === 'rate' ? fmtRate(value) : fmtCount(value)}
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-medium">
                <td className={td}>FB</td>
                {metricCols.map((col) => {
                  const value = summary.totalsByHeader?.[col.header] ?? null
                  return (
                    <td key={col.header} className={td}>
                      {col.kind === 'money' ? fmtMoney(value) : col.kind === 'rate' ? fmtRate(value) : fmtCount(value)}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
          {reading && <ReadingEvidenceLine evidence={fbReportReadingEvidence(reading)} />}
          {reading?.warnings.map((warning, index) => (
            <p key={index} className="text-neutral-500">
              {warning.column ?? ''} {t('boards.fbReport.warningSumDiff')}
            </p>
          ))}
          <p className="text-neutral-400">{t('boards.fbReport.note')}</p>
        </div>
      ) : (
        product && !rejected && <p className="text-neutral-500">{t('boards.fbReport.empty')}</p>
      )}
    </div>
  )
}
