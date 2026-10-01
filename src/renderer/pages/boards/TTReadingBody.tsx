import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import {
  formatTikTokAmount,
  formatTikTokCostPerConversion,
  formatTikTokCount,
  formatTikTokRate,
  type TikTokReadingRange,
  type TikTokReadingResult,
  type TikTokReadingSummary
} from '@shared/tiktokReport'
import { useT, type I18nKey } from '../../i18n'
import { ttReadingRangeLabel } from './metricLabel'

/**
 * TT 读数 board module body. Unlike FB 读数 (its own verified browser
 * pipeline), every read goes straight through Main's TT_READING_SUMMARY IPC:
 * Main resolves the token (official OAuth connector's auto-refreshed token
 * first, paste store as fallback), pulls the integrated report and returns
 * the aggregated projection rendered here. `no-credentials` degrades to a
 * connect hint instead of an error. Chat view can refresh this module —
 * the read does not use the browser panel.
 */

function isTikTokReadingRangeValue(value: unknown): value is TikTokReadingRange {
  return value === '1' || value === '7' || value === '28'
}

function readingErrorMessage(error: string, t: (key: I18nKey) => string): string {
  if (error === 'invalid-input') return t('boards.tt.invalidAdvertisers')
  if (/^[a-z0-9-]+$/.test(error)) return t('boards.reading.refreshFailed')
  return error
}

function Metric({
  label,
  value,
  emphasis = false
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl bg-ink-850 px-2.5 py-2">
      <div className="text-[12px] leading-[18px] text-cream-faint">{label}</div>
      <div
        className={`tabular-nums text-cream ${
          emphasis ? 'text-[20px] font-semibold leading-7' : 'text-[15px] font-medium leading-6'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

export function TTReadingBody({ widget }: { widget: BoardWidget }) {
  const t = useT()
  const navigate = useNavigate()
  const advertiserIds = typeof widget.config.advertiserIds === 'string' ? widget.config.advertiserIds : ''
  const range = isTikTokReadingRangeValue(widget.config.range) ? widget.config.range : '7'
  const [summary, setSummary] = useState<TikTokReadingSummary | null>(null)
  const [notConnected, setNotConnected] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)

  const load = useCallback(async () => {
    requestVersion.current += 1
    const version = requestVersion.current
    setBusy(true)
    setErrorText(null)
    try {
      const result: TikTokReadingResult = await window.electronAPI.ttReadingSummary({ advertiserIds, range })
      if (version !== requestVersion.current) return
      if ('ok' in result) {
        setSummary(null)
        setNotConnected(result.error === 'no-credentials')
        setErrorText(result.error === 'no-credentials' ? null : result.error)
      } else {
        setSummary(result)
        setNotConnected(false)
        setErrorText(null)
      }
    } catch {
      if (version === requestVersion.current) setErrorText('invoke-failed')
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

  // Board-level refresh queue: BoardsPage dispatches a board-refresh event per
  // reading module and serially waits for each module-done before advancing.
  useEffect(() => {
    const onBoardRefresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { widgetId?: string }
      if (detail?.widgetId !== widget.id) return
      void load().finally(() => {
        window.dispatchEvent(new CustomEvent('tt-reading:module-done', { detail: { widgetId: widget.id } }))
      })
    }
    window.addEventListener('tt-reading:board-refresh', onBoardRefresh)
    return () => window.removeEventListener('tt-reading:board-refresh', onBoardRefresh)
  }, [load, widget.id])

  if (notConnected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="max-w-[240px] text-[13px] leading-5 text-cream-dim">{t('boards.tt.noCredentials')}</p>
        <button
          type="button"
          onClick={() => navigate('/connections')}
          className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] leading-5 text-cream transition hover:bg-ink-850"
        >
          {t('boards.tt.goConnect')}
        </button>
      </div>
    )
  }

  const totals = summary?.totals
  const pending = busy && !totals
  const placeholder = pending ? t('boards.tt.loading') : '—'
  const windowLabel = summary
    ? summary.startDate === summary.endDate
      ? summary.startDate
      : `${summary.startDate} – ${summary.endDate}`
    : ''
  const updated = summary ? new Date(summary.generatedAt).toLocaleString() : ''

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] leading-[18px] text-cream-dim">
            {advertiserIds.trim() || t('boards.tt.allAdvertisers')}
          </p>
          <p className="truncate text-[12px] leading-[18px] text-cream-faint">
            {ttReadingRangeLabel(t, range)}
            {windowLabel ? ` · ${windowLabel}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="focus-ring flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] leading-[18px] text-cream-dim transition hover:bg-ink-850 hover:text-cream disabled:opacity-40"
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          {busy ? t('boards.reading.refreshing') : t('boards.reading.refresh')}
        </button>
      </div>

      {errorText && (
        <p role="alert" className="text-[12px] leading-[18px] text-red-600 dark:text-red-400">
          {readingErrorMessage(errorText, t)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <Metric
          emphasis
          label={t('boards.tt.metric.spend')}
          value={totals ? formatTikTokAmount(totals.spend) : placeholder}
        />
        <Metric
          label={t('boards.tt.metric.ctr')}
          value={totals ? formatTikTokRate(totals.clicks, totals.impressions) : placeholder}
        />
        <Metric
          label={t('boards.tt.metric.impressions')}
          value={totals ? formatTikTokCount(totals.impressions) : placeholder}
        />
        <Metric
          label={t('boards.tt.metric.clicks')}
          value={totals ? formatTikTokCount(totals.clicks) : placeholder}
        />
        <Metric
          label={t('boards.tt.metric.conversions')}
          value={totals ? formatTikTokCount(totals.conversions) : placeholder}
        />
        <Metric
          label={t('boards.tt.metric.costPerConversion')}
          value={totals ? formatTikTokCostPerConversion(totals.spend, totals.conversions) : placeholder}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {summary && summary.topCampaigns.length > 0 ? (
          <table className="w-full border-collapse text-left text-[12px] leading-[18px]">
            <thead>
              <tr className="text-cream-faint">
                <th className="px-1 py-1 text-left font-normal">{t('boards.tt.topCampaigns')}</th>
                <th className="px-1 py-1 text-right font-normal">{t('boards.tt.metric.spend')}</th>
                <th className="px-1 py-1 text-right font-normal">{t('boards.tt.metric.clicks')}</th>
                <th className="px-1 py-1 text-right font-normal">{t('boards.tt.metric.conversions')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.topCampaigns.map((campaign) => (
                <tr key={campaign.name} className="border-t border-line/60">
                  <td className="max-w-[8rem] truncate px-1 py-1 text-cream-dim" title={campaign.name}>
                    {campaign.name}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatTikTokAmount(campaign.spend)}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatTikTokCount(campaign.clicks)}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{formatTikTokCount(campaign.conversions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-[12px] leading-[18px] text-cream-faint">
            {errorText || pending ? '' : t('boards.tt.noCampaigns')}
          </div>
        )}
      </div>

      {summary && (
        <p className="text-[12px] leading-[18px] text-cream-faint">
          {t('boards.reading.updatedAt', { time: updated })}
          {' · '}
          {summary.source === 'oauth' ? t('boards.tt.source.oauth') : t('boards.tt.source.pasted')}
          {' · '}
          {t('boards.tt.currencyNote')}
        </p>
      )}
    </div>
  )
}
