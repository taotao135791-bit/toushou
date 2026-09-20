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

interface AccountRecord {
  alias: string
  act: string
  businessId: string | null
  entry: FbReadingHistoryEntry | null
  error: string | null
  balance: FbAccountBalance | null
  balanceError: string | null
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
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
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
    setBusyIndex(null)
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
    if (accounts.length === 0 || submitting.current) {
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      return
    }
    submitting.current = true
    const version = requestVersion.current
    let current = recordsRef.current
    if (current.length !== accounts.length) {
      current = accounts.map((account) => ({ ...account, entry: null, error: null, balance: null, balanceError: null }))
      if (version === requestVersion.current) setRecords(current)
    }
    try {
      for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index]
        if (version !== requestVersion.current) return
        setBusyIndex(index)
        setRecords((prev) =>
          prev.map((record) => (record.act === account.act ? { ...record, error: null } : record))
        )
        const result = await window.electronAPI.refreshFbReading({
          alias: account.alias,
          act: account.act,
          businessId: account.businessId,
          range
        })
        if (version !== requestVersion.current) return
        setRecords((prev) =>
          prev.map((record) =>
            record.act === account.act
              ? {
                  ...record,
                  entry: result.ok ? result.entry : record.entry,
                  error: result.ok ? null : result.error
                }
              : record
          )
        )
      }
    } catch {
      if (version === requestVersion.current) {
        setRecords((prev) => prev.map((record) => ({ ...record, error: record.error ?? 'invoke-failed' })))
      }
    } finally {
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      if (version === requestVersion.current) {
        submitting.current = false
        setBusyIndex(null)
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
  const completeForDisplay = summary.complete && records.every((record) => record.error === null)
  const verifiedForDisplay = records.filter((record) => record.error === null && record.entry !== null).length
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
              disabled={busyIndex !== null || balanceBusyIndex !== null || inChat}
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
            disabled={busyIndex !== null || balanceBusyIndex !== null || inChat}
            title={inChat ? t('boards.reading.inChat') : undefined}
            className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
          >
            {busyIndex !== null ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
            {busyIndex !== null
              ? t('boards.reading.summary.refreshing', { done: String(busyIndex + 1), total: String(accounts.length) })
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
                      <td className="py-0.5 text-right text-[9.5px] text-red-500" title={error ?? ''}>
                        {error ? '!' : account?.capturedAt ? '✓' : '—'}
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
