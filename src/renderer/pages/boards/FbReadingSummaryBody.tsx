import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import {
  boardReadingRangeDates,
  fbReadingMatchesWindow,
  resolveFbReadingSummaryAccounts,
  summarizeFbReadings,
  type FbReadingHistoryEntry,
  type FbReadingRange,
  type FbReadingSummaryMetric
} from '@shared/fbReading'
import type { FbAccountBalance } from '@shared/fbBillingParser'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'
import { readingBlockKind, refreshAccountWithRetry, type ReadingAttemptProgress } from './fbReadingRefresh'

interface AccountRecord {
  alias: string
  act: string
  businessId: string | null
  entry: FbReadingHistoryEntry | null
  error: string | null
  balance: FbAccountBalance | null
  balanceError: string | null
}

/** One account's state in the CURRENT refresh round (kept apart from data). */
interface AccountProgress {
  status: 'idle' | 'queued' | 'reading' | 'retrying' | 'success' | 'failed' | 'skipped'
  attempt: number
  error?: string
  retryAt?: number
}

const SUMMARY_METRICS: FbReadingSummaryMetric[] = ['spend', 'balance', 'cpi', 'cpm', 'ctr', 'cpa']

/**
 * Product-level FB reading summary. Accounts refresh serially through the
 * same verified pipeline as the single-account module; additive fields sum
 * first and ratio metrics are recomputed from the summed denominators.
 */
export function FbReadingSummaryBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const inChat = useAppStore((s) => s.workspacePanel) === null
  const accounts = useMemo(() => resolveFbReadingSummaryAccounts(widget.config), [widget.config])
  const range = (typeof widget.config.range === 'string' ? widget.config.range : 'last7') as FbReadingRange
  const metrics = useMemo(() => {
    const raw = Array.isArray(widget.config.metrics) ? widget.config.metrics : ['spend', 'cpi', 'cpm']
    return raw.filter((metric): metric is FbReadingSummaryMetric => SUMMARY_METRICS.includes(metric as FbReadingSummaryMetric))
  }, [widget.config.metrics])
  const [records, setRecords] = useState<AccountRecord[]>(() =>
    accounts.map((account) => ({ ...account, entry: null, error: null, balance: null, balanceError: null }))
  )
  const [progress, setProgress] = useState<Record<string, AccountProgress>>({})
  const [hasRefreshRun, setHasRefreshRun] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [balanceBusyIndex, setBalanceBusyIndex] = useState<number | null>(null)
  const submitting = useRef(false)
  const balanceSubmitting = useRef(false)
  const requestVersion = useRef(0)
  const recordsRef = useRef(records)
  recordsRef.current = records

  const loadRecords = async (): Promise<AccountRecord[]> =>
    Promise.all(
      accounts.map(async (account) => {
        const list = await window.electronAPI.listFbReadings({ accountId: account.act })
        const entries = Array.isArray(list) ? list : []
        const dateWindow = boardReadingRangeDates(range)
        const entry = entries.find((item) => fbReadingMatchesWindow(item, account.act, dateWindow)) ?? null
        const balances = metrics.includes('balance')
          ? await window.electronAPI.listFbAccountBalances({ accountId: account.act })
          : []
        return { ...account, entry, error: null, balance: balances[0] ?? null, balanceError: null }
      })
    )

  useEffect(() => {
    requestVersion.current += 1
    const version = requestVersion.current
    setRecords(accounts.map((account) => ({ ...account, entry: null, error: null, balance: null, balanceError: null })))
    setProgress({})
    setHasRefreshRun(false)
    setRefreshing(false)
    setBalanceBusyIndex(null)
    submitting.current = false
    balanceSubmitting.current = false
    void loadRecords()
      .then((next) => {
        if (version === requestVersion.current) setRecords(next)
      })
      .catch(() => {
        if (version === requestVersion.current) {
          setRecords((prev) => prev.map((record) => ({ ...record, error: record.error ?? 'history-failed' })))
        }
      })
    return () => {
      requestVersion.current += 1
    }
  }, [accounts, range, metrics])

  const refresh = async () => {
    if (accounts.length === 0) {
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      return
    }
    // A running batch owns this module: duplicate clicks/events rejoin it and
    // must NOT emit an early module-done (that used to advance the board
    // queue while accounts were still reading).
    if (submitting.current || balanceSubmitting.current) return
    submitting.current = true
    setRefreshing(true)
    const version = requestVersion.current
    setHasRefreshRun(true)
    // Key records by act+businessId from the CURRENT list: an equal-length
    // replacement used to be refreshed against stale records.
    const batchAccounts = [...accounts]
    const current: AccountRecord[] = batchAccounts.map((account) => {
      const existing = recordsRef.current.find(
        (record) => record.act === account.act && record.businessId === account.businessId
      )
      return existing
        ? { ...existing, ...account, error: null }
        : { ...account, entry: null, error: null, balance: null, balanceError: null }
    })
    if (version === requestVersion.current) {
      setRecords(current)
      setProgress(Object.fromEntries(batchAccounts.map((account) => [account.act, { status: 'queued' as const, attempt: 0 }])))
    }
    // login/browser blocks stop the batch: remaining accounts are skipped,
    // not failed — they never ran.
    let block: 'login' | 'browser' | null = null
    try {
      for (const account of batchAccounts) {
      if (version !== requestVersion.current) return
        const applyProgress = (next: ReadingAttemptProgress) => {
          if (version !== requestVersion.current) return
          setProgress((prev) => ({
            ...prev,
            [account.act]: {
              status: next.status,
              attempt: next.attempt,
              error: next.lastError,
              retryAt: next.retryAt
            }
          }))
        }
        if (block) {
          setProgress((prev) => ({
            ...prev,
            [account.act]: { status: 'skipped', attempt: 0, error: block === 'login' ? 'login-required' : 'browser-busy' }
          }))
          continue
        }
        applyProgress({ status: 'reading', attempt: 1 })
        const outcome = await refreshAccountWithRetry(
          { alias: account.alias, act: account.act, businessId: account.businessId, range },
          { isCurrent: () => version === requestVersion.current, onProgress: applyProgress }
        )
      if (version !== requestVersion.current) return
        if (outcome.kind === 'cancelled') return
        if (outcome.kind === 'ok') {
          setRecords((prev) =>
            prev.map((record) => (record.act === account.act ? { ...record, entry: outcome.entry, error: null } : record))
          )
          setProgress((prev) => ({ ...prev, [account.act]: { status: 'success', attempt: 0 } }))
          continue
        }
        // One account failing must not poison the batch: keep prior entries,
        // record the precise error, and keep going unless the block is fatal.
        setRecords((prev) =>
          prev.map((record) => (record.act === account.act ? { ...record, error: outcome.error } : record))
        )
        setProgress((prev) => ({ ...prev, [account.act]: { status: 'failed', attempt: 0, error: outcome.error } }))
        block = readingBlockKind(outcome.error)
      }
    } finally {
      // Emitted exactly once, after the whole batch settles (or is cancelled).
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      if (version === requestVersion.current) {
        submitting.current = false
        setRefreshing(false)
      }
    }
  }

  const refreshBalances = async () => {
    if (accounts.length === 0 || !metrics.includes('balance') || balanceSubmitting.current || submitting.current) return
    balanceSubmitting.current = true
    const version = requestVersion.current
    try {
      for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index]
        if (version !== requestVersion.current) return
        setBalanceBusyIndex(index)
        setRecords((prev) =>
          prev.map((record) => (record.act === account.act ? { ...record, balanceError: null } : record))
        )
        const result = await window.electronAPI.refreshFbAccountBalance({
          alias: account.alias,
          act: account.act,
          businessId: account.businessId
        })
        if (version !== requestVersion.current) return
        setRecords((prev) =>
          prev.map((record) =>
            record.act === account.act
              ? {
                  ...record,
                  balance: result.ok ? result.balance : record.balance,
                  balanceError: result.ok ? null : result.error
                }
              : record
          )
        )
      }
    } catch {
      if (version === requestVersion.current) {
        setRecords((prev) => prev.map((record) => ({ ...record, balanceError: record.balanceError ?? 'invoke-failed' })))
      }
    } finally {
      if (version === requestVersion.current) {
        balanceSubmitting.current = false
        setBalanceBusyIndex(null)
      }
    }
  }

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent).detail as { widgetId?: string }
      if (detail?.widgetId !== widget.id) return
      void refreshRef.current()
    }
    window.addEventListener('fb-reading:board-refresh', onRequest)
    return () => window.removeEventListener('fb-reading:board-refresh', onRequest)
  }, [widget.id])

  const summary = useMemo(
    () =>
      summarizeFbReadings(
        accounts,
        Object.fromEntries(records.map((record) => [record.act, record.entry])),
        Object.fromEntries(records.map((record) => [record.act, record.balance]))
      ),
    [accounts, records]
  )
  const rangeLabel = range === 'today' ? '今天' : range === 'last3' ? '近3天' : range === 'last7' ? '近7天' : '近30天'
  const updated = summary.capturedAt ? new Date(summary.capturedAt).toLocaleString() : ''
  // This-round success is tracked separately from stored history: an old
  // verified entry must never be counted as a fresh success mid-refresh.
  const progressOf = (act: string) => progress[act]?.status ?? 'idle'
  const statuses = accounts.map((account) => progressOf(account.act))
  const successCount = statuses.filter((status) => status === 'success').length
  const failedCount = statuses.filter((status) => status === 'failed' || status === 'skipped').length
  const finishedCount = successCount + failedCount
  const refreshSucceeded = !hasRefreshRun || accounts.every((account) => progressOf(account.act) === 'success')
  const completeForDisplay =
    summary.complete && records.every((record) => record.error === null) && refreshSucceeded
  const verifiedForDisplay = hasRefreshRun
    ? successCount
    : records.filter((record) => record.error === null && record.entry !== null).length
  const cell = (value: number | null, kind: 'usd' | 'pct') =>
    value === null ? '—' : kind === 'usd' ? '$' + value.toFixed(2) : value.toFixed(2) + '%'
  const metricLabel = (metric: FbReadingSummaryMetric) => {
    if (metric === 'spend') return t('boards.reading.summary.metric.spend')
    if (metric === 'balance') return t('boards.reading.balance.label')
    if (metric === 'cpi') return t('boards.reading.summary.metric.cpi')
    if (metric === 'cpm') return t('boards.reading.summary.metric.cpm')
    if (metric === 'ctr') return t('boards.reading.summary.metric.ctr')
    return t('boards.reading.summary.metric.cpa')
  }
  const metricValue = (metric: FbReadingSummaryMetric) => {
    if (metric === 'balance') {
      if (records.some((record) => record.balanceError !== null) || summary.balance === null) return '—'
      return formatMoney(summary.balance, summary.balanceCurrency)
    }
    if (!completeForDisplay) return '—'
    if (metric === 'spend') return cell(summary.spend, 'usd')
    if (metric === 'cpi') return cell(summary.cpi, 'usd')
    if (metric === 'cpm') return cell(summary.cpm, 'usd')
    if (metric === 'ctr') return cell(summary.ctr, 'pct')
    return cell(summary.cpa, 'usd')
  }
  const errorText = (code: string | null) => {
    if (!code) return null
    if (code === 'login-required') return t('boards.reading.error.login')
    if (code === 'page-load-failed') return t('boards.reading.error.page')
    if (code.startsWith('ERR_') || code === 'navigation-timeout') return t('boards.reading.error.network')
    if (code === 'date-mismatch') return t('boards.reading.error.date')
    if (code === 'browser-busy') return t('boards.reading.error.busy')
    if (code === 'panel-hidden') return t('boards.reading.error.closed')
    if (code === '2fa-required') return t('boards.reading.balance.error.2fa')
    return t('boards.reading.refreshFailed')
  }
  const formatMoney = (value: number, currency: string | null): string =>
    currency === 'USD' ? '$' + value.toFixed(2) : `${value.toFixed(2)} ${currency ?? ''}`.trim()
  const statusCell = (record: AccountRecord) => {
    const state = progress[record.act]
    if (state) {
      if (state.status === 'queued') {
        return <span className="text-cream-faint">{t('boards.reading.status.queued')}</span>
      }
      if (state.status === 'reading') {
        return <span className="text-cream-dim">{t('boards.reading.status.reading')}</span>
      }
      if (state.status === 'retrying') {
        const seconds = state.retryAt ? Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000)) : null
        return (
          <span className="text-cream-dim">
            {seconds
              ? t('boards.reading.status.retryWait', { s: String(seconds) })
              : t('boards.reading.status.retrying')}
          </span>
        )
      }
      if (state.status === 'success') {
        return <span className="text-emerald-400">{t('boards.reading.status.success')}</span>
      }
      if (state.status === 'failed') {
        const stale = record.entry ? ' · ' + t('boards.reading.stale') : ''
        return (
          <span className="text-red-500" title={errorText(state.error ?? record.error ?? null) ?? ''}>
            {t('boards.reading.status.accountFailed')}{stale}
          </span>
        )
      }
      if (state.status === 'skipped') {
        return (
          <span className="text-cream-faint" title={errorText(state.error ?? null) ?? ''}>
            {t('boards.reading.status.skipped')}
          </span>
        )
      }
    }
    return record.error ? '!' : summary.accounts.find((item) => item.act === record.act)?.capturedAt ? '✓' : '—'
  }

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-cream-faint">
          {accounts.map((account) => account.alias).join(' + ') || t('boards.reading.summary.noAccounts')} · {rangeLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {metrics.includes('balance') && (
            <button
              onClick={() => void refreshBalances()}
              disabled={refreshing || balanceBusyIndex !== null || inChat}
              title={inChat ? t('boards.reading.inChat') : undefined}
              className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
            >
              {balanceBusyIndex !== null ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
              {balanceBusyIndex !== null
                ? t('boards.reading.balance.refreshingAccounts', {
                    done: String(balanceBusyIndex + 1),
                    total: String(accounts.length)
                  })
                : t('boards.reading.balance.refresh')}
            </button>
          )}
          <button
            onClick={() => void refresh()}
            disabled={refreshing || balanceBusyIndex !== null || inChat}
            title={inChat ? t('boards.reading.inChat') : undefined}
            className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
          >
            {refreshing ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
            {refreshing
              ? t('boards.reading.summary.refreshing', { done: String(finishedCount), total: String(accounts.length) })
              : t('boards.reading.refresh')}
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-2 text-center text-[11px] leading-5 text-cream-faint">
          {t('boards.reading.summary.noAccounts')}
        </div>
      ) : (
        <>
          {!completeForDisplay && (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-4 text-amber-300">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              <span>
                {t('boards.reading.summary.partial')
                  .replace('{verified}', String(verifiedForDisplay))
                  .replace('{total}', String(summary.accountCount))}
              </span>
            </div>
          )}
          {refreshing && (
            <div className="text-[10px] text-cream-faint">
              {t('boards.reading.summary.progress', {
                done: String(finishedCount),
                total: String(accounts.length),
                ok: String(successCount),
                failed: String(failedCount)
              })}
            </div>
          )}
          <div className="grid grid-cols-3 gap-1">
            {metrics.map((metric) => (
              <div key={metric} className="rounded-lg bg-ink-850 px-2 py-1.5">
                <div className="text-[9.5px] uppercase text-cream-faint">{metricLabel(metric)}</div>
                <div className="font-mono text-[14px] font-semibold text-cream tabular-nums">{metricValue(metric)}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-cream-faint">
            {summary.campaignCount ?? '—'} {t('boards.reading.summary.campaigns')} ·{' '}
            {updated ? t('boards.reading.updatedAt', { time: updated }) : t('boards.reading.summary.noData')}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-[10.5px]">
              <thead>
                <tr className="text-cream-faint">
                  <th className="px-1 py-0.5 font-normal">{t('boards.reading.summary.account')}</th>
                  {metrics.includes('spend') && <th className="px-1 py-0.5 font-normal">{metricLabel('spend')}</th>}
                  {metrics.includes('balance') && <th className="px-1 py-0.5 font-normal">{metricLabel('balance')}</th>}
                  {metrics.includes('cpi') && <th className="px-1 py-0.5 font-normal">{metricLabel('cpi')}</th>}
                  {metrics.includes('cpm') && <th className="px-1 py-0.5 font-normal">{metricLabel('cpm')}</th>}
                  {metrics.includes('ctr') && <th className="px-1 py-0.5 font-normal">{metricLabel('ctr')}</th>}
                  {metrics.includes('cpa') && <th className="px-1 py-0.5 font-normal">{metricLabel('cpa')}</th>}
                  <th className="w-4" />
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const account = summary.accounts.find((item) => item.act === record.act)
                  const error = errorText(record.error ?? record.balanceError)
                  return (
                    <tr key={record.act} className="border-t border-line/60">
                      <td className="max-w-[110px] truncate px-1 py-0.5 text-cream-dim" title={record.alias}>
                        {record.alias}
                      </td>
                      {metrics.includes('spend') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums">{cell(account?.spend ?? null, 'usd')}</td>
                      )}
                      {metrics.includes('balance') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums" title={account?.balanceText ?? ''}>
                          {account?.balanceText ?? '—'}
                        </td>
                      )}
                      {metrics.includes('cpi') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums">{cell(account?.cpi ?? null, 'usd')}</td>
                      )}
                      {metrics.includes('cpm') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums">{cell(account?.cpm ?? null, 'usd')}</td>
                      )}
                      {metrics.includes('ctr') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums">{cell(account?.ctr ?? null, 'pct')}</td>
                      )}
                      {metrics.includes('cpa') && (
                        <td className="px-1 py-0.5 font-mono tabular-nums">{cell(account?.cpa ?? null, 'usd')}</td>
                      )}
                      <td className="py-0.5 text-right text-[9.5px]" title={error ?? ''}>
                        {statusCell(record)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
