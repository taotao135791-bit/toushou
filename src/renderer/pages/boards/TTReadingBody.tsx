import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { BoardWidget } from '@shared/types'
import type { ReadingErrorCode } from '@shared/readingError'
import {
  formatTikTokAmount,
  formatTikTokCostPerConversion,
  formatTikTokCount,
  formatTikTokRate,
  type TikTokReadingAdvertiser,
  type TikTokReadingRange,
  type TikTokReadingResult,
  type TikTokReadingSummary
} from '@shared/tiktokReport'
import { formatReadingWindow, tiktokReadingRangeWindow } from '@shared/todayReading'
import { useT } from '../../i18n'
import { useAppStore } from '../../store'
import { ttReadingRangeLabel } from './metricLabel'
import { ReadingErrorNotice, tiktokReadingNotice, type ReadingNextStep } from './ReadingErrorNotice'

/**
 * TT 读数 board module body. Unlike FB 读数 (its own verified browser
 * pipeline), every read goes straight through Main's TT_READING_SUMMARY IPC:
 * Main resolves the token (official OAuth connector's auto-refreshed token
 * first, paste store as fallback), pulls the integrated report and returns
 * the aggregated projection rendered here. Failures arrive as reading error
 * codes and render as one plain sentence plus the next step. Chat view can
 * refresh this module — the read does not use the browser panel.
 */

function isTikTokReadingRangeValue(value: unknown): value is TikTokReadingRange {
  return value === '1' || value === '7' || value === '28'
}

function advertiserLabel(advertiser: TikTokReadingAdvertiser): string {
  return advertiser.name ?? advertiser.advertiserId
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
  const language = useAppStore((state) => state.language)
  const advertiserIds = typeof widget.config.advertiserIds === 'string' ? widget.config.advertiserIds : ''
  const range = isTikTokReadingRangeValue(widget.config.range) ? widget.config.range : '7'
  const [summary, setSummary] = useState<TikTokReadingSummary | null>(null)
  const [failure, setFailure] = useState<{ code: ReadingErrorCode | 'invoke-failed'; detail?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)

  const load = useCallback(async () => {
    requestVersion.current += 1
    const version = requestVersion.current
    setBusy(true)
    setFailure(null)
    try {
      const result: TikTokReadingResult = await window.electronAPI.ttReadingSummary({ advertiserIds, range })
      if (version !== requestVersion.current) return
      if ('ok' in result) {
        setSummary(null)
        setFailure({ code: result.error, detail: result.detail })
      } else {
        setSummary(result)
      }
    } catch {
      if (version === requestVersion.current) setFailure({ code: 'invoke-failed' })
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

  const runStep = (step: ReadingNextStep) => {
    if (step === 'retry') void load()
    else if (step === 'edit-module') {
      window.dispatchEvent(new CustomEvent('board-widget:configure', { detail: { widgetId: widget.id } }))
    } else navigate('/connections')
  }

  const separator = language === 'zh' ? '、' : ', '
  const read = summary ? [...summary.advertisers, ...summary.failed] : []
  const accountsLabel = read.length > 0
    ? read.map(advertiserLabel).join(separator)
    : advertiserIds.trim() || t('boards.tt.allAdvertisers')
  const accountsTitle = read.length > 0
    ? read.map((advertiser) => advertiser.name ? `${advertiser.name} (${advertiser.advertiserId})` : advertiser.advertiserId).join('\n')
    : accountsLabel
  const windowLabel = formatReadingWindow(
    summary ? { start: summary.startDate, end: summary.endDate } : tiktokReadingRangeWindow(range)
  )
  const totals = summary?.totals
  const pending = busy && !totals
  const placeholder = pending ? t('boards.tt.loading') : '—'
  const mixed = summary?.mixedCurrency === true
  const money = (value: string) => (mixed ? '—' : value)
  const currencies = summary
    ? [...new Set(summary.advertisers.map((advertiser) => advertiser.currency).filter((code): code is string => !!code))]
    : []
  const updated = summary ? new Date(summary.generatedAt).toLocaleString() : ''
  const failedStep: ReadingNextStep = advertiserIds.trim() ? 'edit-module' : 'pick-advertiser'

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] leading-[18px] text-cream-dim" title={accountsTitle}>
            {accountsLabel}
          </p>
          <p className="truncate text-[12px] leading-[18px] tabular-nums text-cream-faint">
            {ttReadingRangeLabel(t, range)} · {windowLabel}
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

      {failure ? (
        <ReadingErrorNotice
          notice={tiktokReadingNotice(failure.code, t)}
          detail={failure.detail}
          onAction={runStep}
          busy={busy}
        />
      ) : (
        <>
          {summary && summary.failed.length > 0 && (
            <div role="status" className="rounded-lg bg-[#F8F2E7] px-2.5 py-1.5 text-[12px] leading-[18px] text-[#866021] dark:bg-[#383229] dark:text-[#DAC393]">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-[3px] shrink-0" />
                <span className="min-w-0">
                  {t('boards.tt.failedAccounts', { n: summary.failed.length })}
                  {summary.failed.map((advertiser) => (
                    <span key={advertiser.advertiserId} className="block truncate" title={advertiser.advertiserId}>
                      {advertiserLabel(advertiser)}{language === 'zh' ? '：' : ': '}{tiktokReadingNotice(advertiser.error, t).message}
                    </span>
                  ))}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[18px]">
                <button
                  type="button"
                  onClick={() => runStep(failedStep)}
                  className="focus-ring rounded-full border border-[#866021]/40 px-2.5 py-0.5 text-[12px] leading-[18px] dark:border-[#DAC393]/40"
                >
                  {failedStep === 'edit-module' ? t('boards.reading.action.editModule') : t('boards.reading.action.pickAdvertiser')}
                </button>
                <details className="min-w-0">
                  <summary className="cursor-pointer select-none">{t('boards.reading.details')}</summary>
                  {summary.failed.map((advertiser) => (
                    <code key={advertiser.advertiserId} className="mt-0.5 block break-all font-mono text-[12px] leading-[18px]">
                      {advertiser.advertiserId}: {advertiser.detail ?? advertiser.error}
                    </code>
                  ))}
                </details>
              </div>
            </div>
          )}

          {mixed && (
            <p role="status" className="rounded-lg bg-[#F8F2E7] px-2.5 py-1.5 text-[12px] leading-[18px] text-[#866021] dark:bg-[#383229] dark:text-[#DAC393]">
              {t('boards.tt.mixedCurrency', { currencies: currencies.join(', ') })}
            </p>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <Metric
              emphasis
              label={t('boards.tt.metric.spend')}
              value={totals ? money(formatTikTokAmount(totals.spend)) : placeholder}
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
              value={totals ? money(formatTikTokCostPerConversion(totals.spend, totals.conversions)) : placeholder}
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
                      <td className="px-1 py-1 text-right tabular-nums">{money(formatTikTokAmount(campaign.spend))}</td>
                      <td className="px-1 py-1 text-right tabular-nums">{formatTikTokCount(campaign.clicks)}</td>
                      <td className="px-1 py-1 text-right tabular-nums">{formatTikTokCount(campaign.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex h-full items-center justify-center px-2 text-center text-[12px] leading-[18px] text-cream-faint">
                {pending ? '' : t('boards.tt.noCampaigns')}
              </div>
            )}
          </div>

          {summary && (
            <p className="text-[12px] leading-[18px] text-cream-faint">
              {t('boards.reading.updatedAt', { time: updated })}
              {' · '}
              {summary.source === 'oauth' ? t('boards.tt.source.oauth') : t('boards.tt.source.pasted')}
              {' · '}
              {summary.currency ?? t('boards.tt.currencyNote')}
            </p>
          )}
        </>
      )}
    </div>
  )
}
