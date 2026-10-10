import { useCallback, useEffect, useState } from 'react'
import { FileSpreadsheet, RefreshCw, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { BoardWidget } from '@shared/types'
import type {
  FbReportAutoFetchResult,
  FbReportImportResult,
  FbReportIssue,
  FbReportStoredReading
} from '@shared/fbReportCsv'
import { buildFbReportAnalysisPrompt } from '@shared/fbReportChat'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'
import { createSessionForCurrentProject } from '../../lib/session'

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

/**
 * FB 报表读数模块：渲染最近一次 verified 导入。导入由 Main 的文件对话框
 * 发起，解析与 verified 校验都在 Main；未通过校验的导入在这里展示人话
 * 原因，旧读数保持不动。
 */
export function FbReportReadingBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const navigate = useNavigate()
  const [reading, setReading] = useState<FbReportStoredReading | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejected, setRejected] = useState<FbReportIssue[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const reportName = typeof widget.config.reportName === 'string' ? widget.config.reportName.trim() : ''
  const reportId = typeof widget.config.reportId === 'string' ? widget.config.reportId.trim() : ''

  const load = useCallback(async () => {
    const stored = await window.electronAPI.fbReportReadingGet(widget.id).catch(() => null)
    setReading(stored ?? null)
  }, [widget.id])

  // Board-level refresh: run auto-fetch when this module's turn comes.
  useEffect(() => {
    const onRefresh = (event: Event): void => {
      const detail = (event as CustomEvent).detail as { widgetId?: string }
      if (detail?.widgetId !== widget.id) return
      void (async () => {
        try {
          if (reportName) await window.electronAPI.fbReportAutoFetch(widget.id, reportName, reportId || undefined)
        } catch {
          // fail-closed: the reading store keeps the last verified data
        } finally {
          await load()
          window.dispatchEvent(new CustomEvent('fb-report-reading:module-done', { detail: { widgetId: widget.id } }))
        }
      })()
    }
    window.addEventListener('fb-report-reading:board-refresh', onRefresh)
    return () => window.removeEventListener('fb-report-reading:board-refresh', onRefresh)
  }, [widget.id, reportName, reportId, load])

  useEffect(() => {
    void load()
  }, [load])

  const runImport = async () => {
    if (busy) return
    setBusy(true)
    setRejected(null)
    setUnavailable(false)
    setCanceled(false)
    setFetchError(null)
    let result: FbReportImportResult | null = null
    try {
      result = await window.electronAPI.fbReportImport(widget.id)
    } catch {
      result = null
    }
    setBusy(false)
    if (!result) {
      setUnavailable(true)
      return
    }
    if (result.ok && result.outcome && !result.outcome.verification.verified) {
      setRejected(result.outcome.verification.fatal)
    } else if (!result.ok && result.canceled) {
      setCanceled(true)
    }
    await load()
  }

  const runAutoFetch = async () => {
    if (busy || !reportName) return
    setBusy(true)
    setRejected(null)
    setUnavailable(false)
    setCanceled(false)
    setFetchError(null)
    let result: FbReportAutoFetchResult | null = null
    try {
      result = await window.electronAPI.fbReportAutoFetch(widget.id, reportName, reportId || undefined)
    } catch {
      result = null
    }
    setBusy(false)
    if (!result) {
      setUnavailable(true)
      return
    }
    if (result.fetchError) {
      setFetchError(fetchErrorText(t, result.fetchError, result.detail))
    } else if (result.ok && result.outcome && !result.outcome.verification.verified) {
      setRejected(result.outcome.verification.fatal)
    }
    await load()
  }

  const summary = reading?.summary ?? null
  // Dynamic columns: every metric the file actually had, in file order.
  const metricCols = summary?.metrics ?? []
  const th = 'px-2 py-1 text-left font-medium text-neutral-500'
  const td = 'px-2 py-1 tabular-nums'

  const sendToAi = async () => {
    if (!reading || !summary) return
    const prompt = buildFbReportAnalysisPrompt(reading.fileName, summary, reading.warnings)
    try {
      const sessionId = await createSessionForCurrentProject()
      if (!sessionId) return
      const store = useAppStore.getState()
      store.setComposerPrefill(prompt)
      store.setComposerAutosend(true)
      store.setCurrentSessionId(sessionId)
      navigate('/')
    } catch {
      setUnavailable(true)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runImport}
          disabled={busy}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50 disabled:opacity-50"
        >
          <FileSpreadsheet size={13} aria-hidden="true" />
          {busy ? t('boards.fbReport.importing') : t('boards.fbReport.import')}
        </button>
        {summary && (
          <button
            type="button"
            onClick={sendToAi}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-50"
          >
            <Sparkles size={13} aria-hidden="true" />
            {t('boards.fbReport.analyze')}
          </button>
        )}
        <button
          type="button"
          onClick={runAutoFetch}
          disabled={busy || !reportName}
          title={reportName ? undefined : t('boards.fbReport.needReportName')}
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

      {canceled && <p className="text-neutral-500">{t('boards.fbReport.canceled')}</p>}
      {unavailable && <p className="text-red-600">{t('boards.fbReport.unavailable')}</p>}
      {fetchError && <p className="text-red-600">{fetchError}</p>}
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

      {summary ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
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
          {reading?.warnings.map((warning, index) => (
            <p key={index} className="text-neutral-500">
              {warning.column ?? ''} {t('boards.fbReport.warningSumDiff')}
            </p>
          ))}
          <p className="text-neutral-400">{t('boards.fbReport.note')}</p>
        </div>
      ) : (
        !rejected && <p className="text-neutral-500">{t('boards.fbReport.empty')}</p>
      )}
    </div>
  )
}
