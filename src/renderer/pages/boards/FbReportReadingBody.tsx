import { useCallback, useEffect, useState } from 'react'
import { FileSpreadsheet, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import type {
  FbReportAutoFetchResult,
  FbReportImportResult,
  FbReportIssue,
  FbReportStoredReading
} from '@shared/fbReportCsv'
import { useT } from '../../i18n'

const fmtMoney = (value: number | null): string => (value === null ? '—' : value.toFixed(2))
const fmtCount = (value: number | null): string => (value === null ? '—' : String(Math.round(value)))
const fmtRate = (value: number | null): string => (value === null ? '—' : value.toFixed(2))

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
  const th = 'px-2 py-1 text-left font-medium text-neutral-500'
  const td = 'px-2 py-1 tabular-nums'

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
                <th className={th}>{t('boards.fbReport.colSpend')}</th>
                <th className={th}>{t('boards.fbReport.colImpressions')}</th>
                <th className={th}>{t('boards.fbReport.colClicks')}</th>
                <th className={th}>{t('boards.fbReport.colInstalls')}</th>
                <th className={th}>{t('boards.fbReport.colPurchases')}</th>
                <th className={th}>CPM</th>
                <th className={th}>CPI</th>
                <th className={th}>CTR(%)</th>
              </tr>
            </thead>
            <tbody>
              {summary.accounts.map((row) => (
                <tr key={row.account} className="border-b border-neutral-100">
                  <td className={td}>{row.account}</td>
                  <td className={td}>{fmtMoney(row.spend)}</td>
                  <td className={td}>{fmtCount(row.impressions)}</td>
                  <td className={td}>{fmtCount(row.clicks)}</td>
                  <td className={td}>{fmtCount(row.installs)}</td>
                  <td className={td}>{fmtCount(row.purchases)}</td>
                  <td className={td}>{fmtMoney(row.cpm)}</td>
                  <td className={td}>{fmtMoney(row.cpi)}</td>
                  <td className={td}>{fmtRate(row.ctr)}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-medium">
                <td className={td}>FB</td>
                <td className={td}>{fmtMoney(summary.totals.spend ?? null)}</td>
                <td className={td}>{fmtCount(summary.totals.impressions ?? null)}</td>
                <td className={td}>{fmtCount(summary.totals.clicks ?? null)}</td>
                <td className={td}>{fmtCount(summary.totals.installs ?? null)}</td>
                <td className={td}>{fmtCount(summary.totals.purchases ?? null)}</td>
                <td className={td}>—</td>
                <td className={td}>—</td>
                <td className={td}>—</td>
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
