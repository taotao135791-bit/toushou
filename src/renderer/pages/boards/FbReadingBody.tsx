import { useEffect, useRef, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import { boardReadingRangeDates, fbReadingMatchesWindow, FB_READING_ACCOUNT_TARGETS } from '@shared/fbReading'
import { useT } from '../../i18n'

/**
 * FB reading module: renders the LATEST verified reading that matches the
 * module's date window, straight from fb_history (verified-only store).
 * Refresh drives Main's navigate+report pipeline directly — no chat session.
 */
export function FbReadingBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const account = typeof widget.config.account === 'string' ? widget.config.account : '三国IOS'
  const range = (typeof widget.config.range === 'string' ? widget.config.range : 'last7') as
    | 'today'
    | 'last3'
    | 'last7'
    | 'last30'
  const metrics = Array.isArray(widget.config.metrics)
    ? (widget.config.metrics as string[]).filter((m) => typeof m === 'string')
    : ['spend', 'cpi']
  const [entry, setEntry] = useState<{
    capturedAt: string
    totalSpend: number | null
    campaignCount: number | null
    rows: { name: string; spend: number | null; costPerResult: number | null; cpm: number | null; ctr: number | null }[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const submitting = useRef(false)
  const requestVersion = useRef(0)

  const load = async () => {
    const version = requestVersion.current
    const accountId = FB_READING_ACCOUNT_TARGETS[account]?.act
    if (!accountId) return
    const list = await window.electronAPI.listFbReadings({ accountId })
    if (version !== requestVersion.current) return
    const listEntries = Array.isArray(list) ? list : []
    const dateWindow = boardReadingRangeDates(range)
    const hit = listEntries.find(
      (e) => fbReadingMatchesWindow(e, accountId, dateWindow)
    )
    if (hit) {
      setEntry({
        capturedAt: hit.capturedAt,
        totalSpend: hit.totalSpend,
        campaignCount: hit.campaignCount,
        rows: (hit.rows ?? []).map((r) => ({
          name: r.name,
          spend: r.spend,
          costPerResult: r.costPerResult,
          cpm: r.cpm,
          ctr: r.ctr
        }))
      })
    } else {
      setEntry(null)
    }
  }

  useEffect(() => {
    requestVersion.current += 1
    setEntry(null)
    setFailure(null)
    setBusy(false)
    submitting.current = false
    const version = requestVersion.current
    void load().catch(() => {
      if (version === requestVersion.current) setFailure('history-failed')
    })
    return () => { requestVersion.current += 1 }
  }, [account, range])

  const refresh = async () => {
    if (submitting.current) return
    submitting.current = true
    const version = requestVersion.current
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.electronAPI.refreshFbReading({ account, range })
      if (version !== requestVersion.current) return
      if (result.ok) {
        await load()
      } else {
        setFailure(result.error)
      }
    } catch {
      if (version === requestVersion.current) setFailure('refresh-failed')
    } finally {
      if (version === requestVersion.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }

  const cell = (v: number | null, kind: 'usd' | 'pct') =>
    v === null ? '—' : kind === 'usd' ? '$' + v.toFixed(2) : v.toFixed(2) + '%'

  const updated = entry ? new Date(entry.capturedAt).toLocaleString() : ''
  const failureMessage = failure === 'page-load-failed' ? t('boards.reading.error.page')
    : failure?.startsWith('ERR_') || failure === 'navigation-timeout' ? t('boards.reading.error.network')
      : failure === 'date-mismatch' ? t('boards.reading.error.date')
        : failure === 'browser-busy' ? t('boards.reading.error.busy')
          : failure === 'panel-hidden' ? t('boards.reading.error.closed')
            : t('boards.reading.refreshFailed')

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-cream-faint">
          {account} · {range === 'today' ? '今天' : range === 'last3' ? '近3天' : range === 'last7' ? '近7天' : '近30天'}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={busy}
          className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
        >
          {busy ? <Activity size={10} className="animate-pulse" /> : <RefreshCw size={10} />}
          {busy ? t('boards.reading.refreshing') : t('boards.reading.refresh')}
        </button>
      </div>
      {failure && <div role="alert" className="text-[10.5px] text-red-500">{failureMessage}</div>}
      {!entry ? (
        <div className="flex flex-1 items-center justify-center px-2 text-center text-[11px] leading-5 text-cream-faint">
          {t('boards.reading.noData')}
        </div>
      ) : (
        <>
          <div className="rounded-lg bg-ink-850 px-2 py-1.5">
            <div className="text-[10.5px] text-cream-faint">
              {entry.campaignCount ?? '—'} 系列 · {t('boards.reading.updatedAt', { time: updated })}
            </div>
            <div className="font-mono text-[16px] font-semibold text-cream tabular-nums">
              ${entry.totalSpend?.toFixed(2) ?? '—'}
            </div>
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
                    {metrics.includes('cpi') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(row.costPerResult, 'usd')}</td>}
                    {metrics.includes('cpm') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(row.cpm, 'usd')}</td>}
                    {metrics.includes('ctr') && <td className="px-1 py-0.5 font-mono tabular-nums">{cell(row.ctr, 'pct')}</td>}
                    {metrics.includes('cpa') && <td className="px-1 py-0.5 text-cream-faint">—</td>}
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
