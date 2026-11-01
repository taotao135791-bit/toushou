import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, FileSpreadsheet, RefreshCw } from 'lucide-react'
import type { BoardWidget, KanbanBoard } from '@shared/types'
import type { ReadingSnapshot } from '@shared/readingSnapshot'
import { googleReadingSnapshot } from '@shared/googleReadingSnapshot'
import { SaveReadingBoardDialog } from './SaveReadingBoardDialog'
import type { GoogleReportImportResult, GoogleReportReadingResult, GoogleReportStoredReading } from '@shared/googleReport'
import { useT, type I18nKey } from '../../i18n'
import { googleReportReadingEvidence } from '@shared/readingEvidence'
import { ReadingEvidenceLine } from './ReadingEvidenceLine'
import { useAppStore } from '../../store'

const fmt = (value: number | null, digits = 0): string => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })

const ERROR_KEYS: Record<string, I18nKey> = {
  'invalid-url': 'boards.googleReport.invalidUrl',
  'login-required': 'boards.googleReport.loginRequired',
  'context-unavailable': 'boards.googleReport.contextUnavailable',
  'missing-account-or-currency': 'boards.googleReport.missingScope',
  'missing-date-range': 'boards.googleReport.missingScope',
  'missing-columns': 'boards.googleReport.missingColumns',
  'export-button-not-found': 'boards.googleReport.exportUnavailable',
  'csv-option-not-found': 'boards.googleReport.exportUnavailable',
  'download-timeout': 'boards.googleReport.downloadFailed',
  'download-failed': 'boards.googleReport.downloadFailed'
}

/** Shows only a verified snapshot. Failed reads leave the previous snapshot visible. */
export function GoogleReportReadingBody({ widget, onSnapshotSaved }: { widget: BoardWidget; onSnapshotSaved?: (board: KanbanBoard) => void }) {
  const t = useT()
  const language = useAppStore(state => state.language) === 'en' ? 'en' : 'zh'
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const reportUrl = typeof widget.config.reportUrl === 'string' ? widget.config.reportUrl : ''
  const [reading, setReading] = useState<GoogleReportStoredReading | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotToSave, setSnapshotToSave] = useState<ReadingSnapshot | null>(null)
  const sourceChanged = !!reading?.sourceUrl && reading.sourceUrl !== reportUrl
  const inFlight = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    const version = ++generation.current
    setReading(null)
    setError(null)
    void window.electronAPI.googleReportReadingGet(widget.id).then((value) => {
      if (generation.current === version) setReading(value)
    }).catch(() => { if (generation.current === version) setError('read-failed') })
    return () => { generation.current++ }
  }, [widget.id])

  const run = useCallback(async (importFile = false) => {
    if (inFlight.current || (!importFile && !reportUrl)) return
    inFlight.current = true
    const version = generation.current
    setBusy(true)
    setError(null)
    try {
      const result: GoogleReportImportResult | GoogleReportReadingResult = importFile
        ? await window.electronAPI.googleReportImport(widget.id)
        : await window.electronAPI.googleReportAutoFetch(widget.id, reportUrl)
      if (version !== generation.current) return
      if (result.reading) setReading(result.reading)
      else if (!result.canceled) {
        const fetchError = 'fetchError' in result ? result.fetchError : undefined
        setError(fetchError ?? result.outcome?.verification.errors[0] ?? result.error ?? 'read-failed')
      }
    } catch {
      if (version === generation.current) setError('read-failed')
    } finally {
      inFlight.current = false
      if (version === generation.current) setBusy(false)
    }
  }, [reportUrl, widget.id])

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ widgetId?: string }>).detail?.widgetId !== widget.id) return
      void run().finally(() => window.dispatchEvent(new CustomEvent('google-report-reading:module-done', { detail: { widgetId: widget.id } })))
    }
    window.addEventListener('google-report-reading:board-refresh', refresh)
    return () => window.removeEventListener('google-report-reading:board-refresh', refresh)
  }, [run, widget.id])

  const openSource = async () => {
    if (!reportUrl) return
    setWorkspacePanel({ kind: 'browser' })
    await window.electronAPI.browserNavigate('go', reportUrl)
  }

  const actionClass = 'focus-ring inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-[12px] text-cream-dim hover:bg-overlay disabled:opacity-40'
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-[12px] leading-[18px]">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={actionClass} disabled={busy || !reportUrl} onClick={() => void run()}>
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          {t(busy ? 'boards.fbReport.autoFetching' : 'boards.googleReport.readLink')}
        </button>
        <button type="button" className={actionClass} disabled={busy || !reportUrl} onClick={() => void openSource().catch(() => setError('read-failed'))}>
          <ExternalLink size={12} />{t('boards.googleReport.openSource')}
        </button>
        <button type="button" className={actionClass} disabled={busy} onClick={() => void run(true)}>
          <FileSpreadsheet size={12} />{t('boards.fbReport.import')}
        </button>
        <button type="button" className={actionClass} disabled={busy || !reading || !!error || sourceChanged || !onSnapshotSaved} onClick={() => { if (reading) { const snapshot = googleReadingSnapshot(reading, Date.now()); if (snapshot) setSnapshotToSave(snapshot); else setError('snapshot-invalid') } }}>
          {language === 'zh' ? '保存为新看板' : 'Save as a new board'}
        </button>
      </div>
      {!reportUrl && <p className="text-cream-faint">{t('boards.googleReport.needUrl')}</p>}
      {sourceChanged && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{t('boards.googleReport.sourceChanged')}</p>}
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <p>{error === 'snapshot-invalid' ? (language === 'zh' ? '当前读数不满足保存条件，请核对报告日期和指标后重试。原读数已保留。' : 'These readings cannot be saved. Check report dates and metrics, then retry. The original readings were retained.') : t(ERROR_KEYS[error] ?? 'boards.googleReport.readFailed')}</p>
          {reading && <p>{t('boards.googleReport.previousKept')}</p>}
        </div>
      )}
      {reading ? (
        <>
          <p className="tabular-nums text-cream-faint">
            {reading.summary.windowStart} — {reading.summary.windowEnd}
            {reading.summary.timezone ? ` · ${reading.summary.timezone}` : ''}
          </p>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse whitespace-nowrap text-left">
              <thead className="text-cream-faint"><tr>
                <th className="px-2 py-1 font-normal">{t('boards.fbReport.colAccount')}</th>
                {(['spend', 'impressions', 'clicks', 'conversions'] as const).map((key) => <th key={key} className="px-2 py-1 text-right font-normal">{t(`boards.tt.metric.${key}`)}</th>)}
              </tr></thead>
              <tbody>{reading.summary.accounts.map((account) => (
                <tr key={account.accountId} className="border-t border-line">
                  <td className="max-w-[180px] truncate px-2 py-2">{account.accountName ?? account.accountId}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{account.currency} {fmt(account.spend, 2)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(account.impressions)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(account.clicks)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(account.conversions, 2)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ReadingEvidenceLine evidence={googleReportReadingEvidence(reading)} />
          <p className="text-cream-faint">{t('boards.googleReport.scopeNote')}</p>
          {reading.warnings.some((warning) => warning !== 'report-scope-only') && <p className="text-amber-700 dark:text-amber-300">{t('boards.googleReport.warnings')}</p>}
        </>
      ) : !busy && <p className="m-auto px-4 text-center text-cream-faint">{t('boards.googleReport.empty')}</p>}
      {snapshotToSave && <SaveReadingBoardDialog snapshot={snapshotToSave} language={language} onClose={() => setSnapshotToSave(null)} onSaved={board => { setSnapshotToSave(null); onSnapshotSaved?.(board) }} />}
    </div>
  )
}
