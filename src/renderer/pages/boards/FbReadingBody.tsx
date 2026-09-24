import { useEffect, useRef, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import { boardReadingRangeDates, fbReadingMatchesWindow, resolveFbReadingWidgetAccount } from '@shared/fbReading'
import type { FbReadingHistoryEntry } from '@shared/fbReading'
import type { FbAccountBalance } from '@shared/fbBillingParser'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'
import { refreshAccountWithRetry } from './fbReadingRefresh'

interface FbReadingDisplayRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  ctr: number | null
  impressions: number | null
  clicks: number | null
  installs: number | null
  results: number | null
  resultType: string | null
}

const APP_INSTALL_TYPES = new Set(['应用安装量', '移动应用安装量', 'App installs', 'Mobile app installs'])

const cpiOf = (row: FbReadingDisplayRow): number | null => {
  if (row.installs !== null && row.installs > 0) return row.spend !== null ? row.spend / row.installs : null
  return row.resultType && APP_INSTALL_TYPES.has(row.resultType) && row.results !== null && row.results > 0 && row.spend !== null
    ? row.spend / row.results
    : null
}

const cpaOf = (row: FbReadingDisplayRow): number | null =>
  row.resultType && row.results !== null && row.results > 0 && row.spend !== null ? row.spend / row.results : null

const cpmOf = (row: FbReadingDisplayRow): number | null =>
  row.spend !== null && row.impressions !== null && row.impressions > 0 ? (row.spend / row.impressions) * 1000 : null

const ctrOf = (row: FbReadingDisplayRow): number | null =>
  row.clicks !== null && row.impressions !== null && row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null

/**
 * FB reading module: renders the LATEST verified reading that matches the
 * module's date window, straight from fb_history (verified-only store).
 * Refresh drives Main's navigate+report pipeline directly — no chat session.
 */
export function FbReadingBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const inChat = useAppStore((s) => s.workspacePanel) === null
  const accountRef = resolveFbReadingWidgetAccount(widget.config)
  const account = accountRef?.alias ?? (typeof widget.config.account === 'string' ? widget.config.account : '')
  const range = (typeof widget.config.range === 'string' ? widget.config.range : 'last7') as
    | 'today'
    | 'last3'
    | 'last7'
    | 'last30'
  const metrics = Array.isArray(widget.config.metrics)
    ? (widget.config.metrics as string[]).filter((m) => typeof m === 'string')
    : ['spend', 'cpi']
  const includeBalance = metrics.includes('balance')
  const [entry, setEntry] = useState<{
    capturedAt: string
    totalSpend: number | null
    campaignCount: number | null
    rows: FbReadingDisplayRow[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [failureDetail, setFailureDetail] = useState<string | null>(null)
  const [balance, setBalance] = useState<FbAccountBalance | null>(null)
  const [balanceFailure, setBalanceFailure] = useState<string | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const submitting = useRef(false)
  const balanceSubmitting = useRef(false)
  const requestVersion = useRef(0)

  const toDisplayEntry = (hit: FbReadingHistoryEntry) => ({
    capturedAt: hit.capturedAt,
    totalSpend: hit.totalSpend,
    campaignCount: hit.campaignCount,
    rows: (hit.rows ?? []).map((r) => ({
      name: r.name,
      spend: r.spend,
      costPerResult: r.costPerResult,
      cpm: r.cpm,
      ctr: r.ctr,
      impressions: r.impressions,
      clicks: r.clicks,
      installs: r.installs,
      results: r.results,
      resultType: r.resultType
    }))
  })

  const load = async () => {
    const version = requestVersion.current
    const accountId = accountRef?.act
    if (!accountId) return
    const list = await window.electronAPI.listFbReadings({ accountId })
    if (version !== requestVersion.current) return
    const listEntries = Array.isArray(list) ? list : []
    const dateWindow = boardReadingRangeDates(range)
    const hit = listEntries.find(
      (e) => fbReadingMatchesWindow(e, accountId, dateWindow)
    )
    setEntry(hit ? toDisplayEntry(hit) : null)
  }

  const loadBalance = async () => {
    const version = requestVersion.current
    const accountId = accountRef?.act
    if (!accountId || !includeBalance) return
    const list = await window.electronAPI.listFbAccountBalances({ accountId })
    if (version !== requestVersion.current) return
    setBalance(Array.isArray(list) && list.length > 0 ? list[0] : null)
  }

  useEffect(() => {
    requestVersion.current += 1
    setEntry(null)
    setBalance(null)
    setFailure(null)
    setBalanceFailure(null)
    setBusy(false)
    setBalanceBusy(false)
    setAttempt(0)
    submitting.current = false
    balanceSubmitting.current = false
    const version = requestVersion.current
    void Promise.all([load(), loadBalance()]).catch(() => {
      if (version === requestVersion.current) setFailure('history-failed')
    })
    return () => { requestVersion.current += 1 }
  }, [account, accountRef?.act, range, includeBalance])

  const refresh = async () => {
    if (!accountRef) {
      setFailure('invalid-input')
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      return
    }
    // A running refresh owns this module; duplicate clicks/events rejoin it
    // and must not emit an early module-done (board queue safety).
    if (submitting.current || balanceSubmitting.current) return
    submitting.current = true
    const version = requestVersion.current
    setBusy(true)
    setFailure(null)
    setFailureDetail(null)
    try {
      const outcome = await refreshAccountWithRetry(
        { alias: accountRef.alias, act: accountRef.act, businessId: accountRef.businessId, range },
        {
          isCurrent: () => version === requestVersion.current,
          onProgress: (next) => {
            if (version !== requestVersion.current) return
            setAttempt(next.attempt)
          }
        }
      )
      if (version !== requestVersion.current) return
      if (outcome.kind === 'ok') {
        setEntry(toDisplayEntry(outcome.entry))
      } else if (outcome.kind === 'failed') {
        setFailure(outcome.error)
        setFailureDetail(outcome.error)
      }
    } finally {
      window.dispatchEvent(new CustomEvent('fb-reading:module-done', { detail: { widgetId: widget.id } }))
      if (version === requestVersion.current) {
        submitting.current = false
        setBusy(false)
        setAttempt(0)
      }
    }
  }

  const refreshBalance = async () => {
    if (!accountRef || !includeBalance || balanceSubmitting.current || submitting.current) return
    balanceSubmitting.current = true
    const version = requestVersion.current
    setBalanceBusy(true)
    setBalanceFailure(null)
    try {
      const result = await window.electronAPI.refreshFbAccountBalance({
        alias: accountRef.alias,
        act: accountRef.act,
        businessId: accountRef.businessId
      })
      if (version !== requestVersion.current) return
      if (result.ok) setBalance(result.balance)
      else setBalanceFailure(result.error)
    } catch {
      if (version === requestVersion.current) setBalanceFailure('invoke-failed')
    } finally {
      if (version === requestVersion.current) {
        balanceSubmitting.current = false
        setBalanceBusy(false)
      }
    }
  }

  // Board-level "refresh all readings" drives each module's own refresh
  // serially; the module reports completion so the queue can proceed.
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

  const cell = (v: number | null, kind: 'usd' | 'pct') =>
    v === null ? '—' : kind === 'usd' ? '$' + v.toFixed(2) : v.toFixed(2) + '%'

  const updated = entry ? new Date(entry.capturedAt).toLocaleString() : ''
  const failureMessage = failure === 'page-load-failed' ? t('boards.reading.error.page')
    : failure === 'login-required' ? t('boards.reading.error.login')
    : failure?.startsWith('ERR_') || failure === 'navigation-timeout' ? t('boards.reading.error.network')
      : failure === 'date-mismatch' ? t('boards.reading.error.date')
        : failure === 'browser-busy' ? t('boards.reading.error.busy')
          : failure === 'panel-hidden' ? t('boards.reading.error.closed')
            : t('boards.reading.refreshFailed')

  const failureNode = (
    <>
      {failureMessage}
      {failureDetail ? ' (' + failureDetail + ')' : ''}
    </>
  )

  const balanceFailureMessage = balanceFailure === '2fa-required'
    ? t('boards.reading.balance.error.2fa')
    : balanceFailure === 'login-required'
      ? t('boards.reading.error.login')
      : balanceFailure?.startsWith('ERR_') || balanceFailure === 'navigation-timeout'
        ? t('boards.reading.error.network')
        : t('boards.reading.balance.error.failed')

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-cream-faint">
          {account} · {range === 'today' ? '今天' : range === 'last3' ? '近3天' : range === 'last7' ? '近7天' : '近30天'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {includeBalance && (
            <button
              onClick={() => void refreshBalance()}
              disabled={busy || balanceBusy || inChat}
              title={inChat ? t('boards.reading.inChat') : undefined}
              className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
            >
              {balanceBusy ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
              {balanceBusy
                ? t('boards.reading.balance.refreshing')
                : t('boards.reading.balance.refresh')}
            </button>
          )}
          <button
            onClick={() => void refresh()}
            disabled={busy || balanceBusy || inChat}
            title={inChat ? t('boards.reading.inChat') : undefined}
            className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
          >
            {busy ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
            {busy
              ? attempt >= 2
                ? t('boards.reading.status.retrying')
                : t('boards.reading.refreshing')
              : t('boards.reading.refresh')}
          </button>
        </div>
      </div>
      {failure && <div role="alert" className="text-[10.5px] text-red-500">{failureNode}</div>}
      {balanceFailure && (
        <div role="alert" className="text-[10.5px] text-amber-400">{balanceFailureMessage}</div>
      )}
      {!entry ? (
        <>
          {includeBalance && (
            <div className="rounded-lg bg-ink-850 px-2 py-1.5">
              <div className="text-[10.5px] text-cream-faint">{t('boards.reading.balance.label')}</div>
              <div className="truncate font-mono text-[16px] font-semibold text-cream tabular-nums" title={balance?.amountText ?? ''}>
                {balance?.amountText ?? '—'}
              </div>
            </div>
          )}
          <div className="flex flex-1 items-center justify-center px-2 text-center text-[11px] leading-5 text-cream-faint">
            {t('boards.reading.noData')}
          </div>
        </>
      ) : (
        <>
          <div className={`rounded-lg bg-ink-850 px-2 py-1.5 ${includeBalance ? 'grid grid-cols-2 gap-2' : ''}`}>
            <div className="text-[10.5px] text-cream-faint">
              {entry.campaignCount ?? '—'} 系列 · {t('boards.reading.updatedAt', { time: updated })}
            </div>
            <div className="font-mono text-[16px] font-semibold text-cream tabular-nums">
              ${entry.totalSpend?.toFixed(2) ?? '—'}
            </div>
            {includeBalance && (
              <div className="min-w-0">
                <div className="text-[10.5px] text-cream-faint">{t('boards.reading.balance.label')}</div>
                <div className="truncate font-mono text-[16px] font-semibold text-cream tabular-nums" title={balance?.amountText ?? ''}>
                  {balance?.amountText ?? '—'}
                </div>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-[10.5px]">
              <thead>
                <tr className="text-cream-faint">
                  <th className="px-1 py-0.5 font-normal">系列</th>
                  {metrics.includes('spend') && <th className="px-1 py-0.5 font-normal">消耗</th>}
                  {metrics.includes('cpi') && <th className="px-1 py-0.5 font-normal">CPI</th>}
                  {metrics.includes('cpm') && <th className="px-1 py-0.5 font-normal">CPM</th>}
                  {metrics.includes('ctr') && <th className="px-1 py-0.5 font-normal">CTR</th>}
                  {metrics.includes('cpa') && <th className="px-1 py-0.5 font-normal">CPA</th>}
                </tr>
              </thead>
              <tbody>
                {entry.rows.map((row) => (
                  <tr key={row.name} className="border-t border-line/60">
                    <td className="max-w-[140px] truncate px-1 py-0.5 text-cream-dim" title={row.name}>
                      {row.name.split('_').pop() ?? row.name}
                    </td>
                    {metrics.includes('spend') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(row.spend, 'usd')}</td>}
                    {metrics.includes('cpi') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(cpiOf(row), 'usd')}</td>}
                    {metrics.includes('cpm') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(cpmOf(row), 'usd')}</td>}
                    {metrics.includes('ctr') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(ctrOf(row), 'pct')}</td>}
                    {metrics.includes('cpa') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(cpaOf(row), 'usd')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
