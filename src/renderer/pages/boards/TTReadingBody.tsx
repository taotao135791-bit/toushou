import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import type { TikTokReadingRange, TikTokReadingResult, TikTokReadingSummary } from '@shared/tiktokReport'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'

/**
 * TT 读数 board module body. Unlike FB 读数 (its own verified browser
 * pipeline), every read goes straight through Main's TT_READING_SUMMARY IPC:
 * Main resolves the token (official OAuth connector's auto-refreshed token
 * first, paste store as fallback), pulls the integrated report and returns
 * the aggregated projection rendered here — totals grid, top campaigns and
 * the fetched-at stamp. `no-credentials` degrades to a connect hint instead
 * of an error.
 */

function isTikTokReadingRangeValue(value: unknown): value is TikTokReadingRange {
  return value === '1' || value === '7' || value === '28'
}

function rangeLabel(range: TikTokReadingRange): string {
  return range === '1' ? '今天' : range === '7' ? '近7天' : '近28天'
}

const fmtInt = (value: number): string => Math.round(value).toLocaleString()
const fmtUsd = (value: number): string => '$' + value.toFixed(2)
const fmtPct = (value: number): string => (value * 100).toFixed(2) + '%'

export function TTReadingBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const navigate = useNavigate()
  const inChat = useAppStore((s) => s.workspacePanel) === null
  const advertiserIds = typeof widget.config.advertiserIds === 'string' ? widget.config.advertiserIds : ''
  const range = isTikTokReadingRangeValue(widget.config.range) ? widget.config.range : '7'
  const [summary, setSummary] = useState<TikTokReadingSummary | null>(null)
  const [notConnected, setNotConnected] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)

  const load = useCallback(async () => {
    requestVersion.current += 1
    const version = requestVersion.current
    setBusy(true)
    setFailed(false)
    try {
      const result: TikTokReadingResult = await window.electronAPI.ttReadingSummary({ advertiserIds, range })
      if (version !== requestVersion.current) return
      if ('ok' in result) {
        setSummary(null)
        setNotConnected(result.error === 'no-credentials')
        setFailed(result.error !== 'no-credentials')
      } else {
        setSummary(result)
        setNotConnected(false)
        setFailed(false)
      }
    } catch {
      if (version === requestVersion.current) setFailed(true)
    } finally {
      if (version === requestVersion.current) setBusy(false)
    }
  }, [advertiserIds, range])

  useEffect(() => {
    void load()
    return () => {
      requestVersion.current += 1
    }
  }, [load])

  const totals = summary?.totals
  const cells: Array<{ label: string; value: string }> = [
    { label: t('boards.tt.metric.spend'), value: totals ? fmtUsd(totals.spend) : '—' },
    { label: t('boards.tt.metric.impressions'), value: totals ? fmtInt(totals.impressions) : '—' },
    { label: t('boards.tt.metric.clicks'), value: totals ? fmtInt(totals.clicks) : '—' },
    { label: t('boards.tt.metric.ctr'), value: totals ? fmtPct(totals.ctr) : '—' },
    { label: t('boards.tt.metric.conversions'), value: totals ? fmtInt(totals.conversions) : '—' },
    { label: t('boards.tt.metric.costPerConversion'), value: totals ? fmtUsd(totals.costPerConversion) : '—' }
  ]
  const updated = summary ? new Date(summary.generatedAt).toLocaleString() : ''

  if (notConnected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
        <span className="text-[11px] leading-5 text-cream-faint">{t('boards.tt.noCredentials')}</span>
        <button
          onClick={() => navigate('/connections')}
          className="rounded-full border border-line px-2.5 py-1 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream"
        >
          {t('boards.tt.goConnect')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10.5px] text-cream-faint">
          {advertiserIds.trim() || t('boards.tt.allAdvertisers')} · {rangeLabel(range)}
        </span>
        <button
          onClick={() => void load()}
          disabled={busy || inChat}
          title={inChat ? t('boards.reading.inChat') : undefined}
          className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-cream-dim transition hover:border-accent/50 hover:text-cream disabled:opacity-40"
        >
          <RefreshCw size={10} className={busy ? 'animate-spin' : ''} />
          {t('boards.reading.refresh')}
        </button>
      </div>

      {failed && (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-4 text-amber-300">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          <span>{t('boards.reading.refreshFailed')}</span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-lg bg-ink-850 px-2 py-1.5">
            <div className="text-[9.5px] uppercase text-cream-faint">{cell.label}</div>
            <div className="font-mono text-[14px] font-semibold text-cream tabular-nums">{cell.value}</div>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {summary && summary.topCampaigns.length > 0 ? (
          <table className="w-full border-collapse text-left text-[10.5px]">
            <thead>
              <tr className="text-cream-faint">
                <th className="px-1 py-0.5 font-normal">{t('boards.tt.topCampaigns')}</th>
                <th className="px-1 py-0.5 text-right font-normal">{t('boards.tt.metric.spend')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.topCampaigns.map((campaign) => (
                <tr key={campaign.name} className="border-t border-line/60">
                  <td className="max-w-[140px] truncate px-1 py-0.5 text-cream-dim" title={campaign.name}>
                    {campaign.name}
                  </td>
                  <td className="px-1 py-0.5 text-right font-mono tabular-nums">{fmtUsd(campaign.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-cream-faint">
            {failed ? '' : t('boards.reading.noData')}
          </div>
        )}
      </div>

      <div className="text-[10px] text-cream-faint">
        {updated ? t('boards.reading.updatedAt', { time: updated }) : ''}
      </div>
    </div>
  )
}
