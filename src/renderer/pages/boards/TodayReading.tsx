import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, RefreshCw } from 'lucide-react'
import {
  fbReadingMatchesWindow,
  type FbReadingAccountEntry,
  type FbReadingHistoryEntry
} from '@shared/fbReading'
import type { ReadingErrorCode } from '@shared/readingError'
import {
  buildTodayChatPrompt,
  fbPresetForTodayRange,
  formatReadingWindow,
  formatSpendDelta,
  isTikTokTodayFailure,
  previousEqualWindow,
  sumFinite,
  todayWindow,
  topSpendMoves,
  type TikTokTodayAccount,
  type TodayCampaignMove,
  type TodayRange,
  type TikTokTodayReading
} from '@shared/todayReading'
import { formatTikTokAmount, formatTikTokCostPerConversion, formatTikTokCount, formatTikTokRate } from '@shared/tiktokReport'
import { useT, type I18nKey } from '../../i18n'
import { useAppStore } from '../../store'
import { refreshAccountWithRetry } from './fbReadingRefresh'
import {
  ReadingErrorNotice,
  fbReadingNotice,
  tiktokReadingNotice,
  type ReadingNextStep,
  type ReadingNotice
} from './ReadingErrorNotice'

const RANGES: TodayRange[] = ['today', 'last7', 'last28']

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string

interface FacebookRow {
  account: FbReadingAccountEntry
  covered: boolean
  spend: number | null
  previousSpend: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  capturedAt: string | null
  movers: TodayCampaignMove[]
}

interface TikTokFailure {
  code: ReadingErrorCode | 'invoke-failed'
  detail?: string
}

function captureFailure(error: string | undefined, t: (key: I18nKey) => string): string {
  if (error === 'not-on-adsmanager') return t('boards.today.notOnAds')
  if (error === 'panel-hidden' || error === 'panel-not-open') return t('boards.today.openBrowserFirst')
  return t('boards.today.captureFailed')
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] leading-[18px] text-cream-faint">{label}</div>
      <div className="text-[15px] font-medium leading-6 tabular-nums text-cream">{value}</div>
    </div>
  )
}

export function TodayReading() {
  const t = useT()
  const navigate = useNavigate()
  const language = useAppStore((state) => state.language)
  const inChat = useAppStore((state) => state.workspacePanel) === null
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const [range, setRange] = useState<TodayRange>('last7')
  const [facebook, setFacebook] = useState<FacebookRow[] | null>(null)
  const [tiktok, setTiktok] = useState<TikTokTodayReading | null>(null)
  const [tiktokFailure, setTiktokFailure] = useState<TikTokFailure | null>(null)
  const [tiktokBusy, setTiktokBusy] = useState(false)
  const [refreshingAct, setRefreshingAct] = useState<string | null>(null)
  const [rowFailure, setRowFailure] = useState<{ act: string; code: string } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureBusy, setCaptureBusy] = useState(false)
  const [openAct, setOpenAct] = useState<string | null>(null)
  const [openTikTok, setOpenTikTok] = useState<string | null>(null)
  const facebookLoad = useRef(0)
  const tiktokLoad = useRef(0)
  const alive = useRef(true)

  const dateWindow = todayWindow(range)
  const previous = previousEqualWindow(dateWindow)
  const preset = fbPresetForTodayRange(range)

  const loadFacebook = useCallback(async () => {
    const id = ++facebookLoad.current
    const accounts = await window.electronAPI.listFbReadingAccounts()
    if (id !== facebookLoad.current) return
    const coveredPreset = fbPresetForTodayRange(range)
    const currentWindow = todayWindow(range)
    const previousWindow = previousEqualWindow(currentWindow)
    if (!coveredPreset || !previousWindow) {
      setFacebook(accounts.map((account) => ({
        account,
        covered: false,
        spend: null,
        previousSpend: null,
        impressions: null,
        clicks: null,
        conversions: null,
        capturedAt: null,
        movers: []
      })))
      return
    }
    const rows = await Promise.all(accounts.map(async (account) => {
      const list = await window.electronAPI.listFbReadings({ accountId: account.act })
      const entries = Array.isArray(list) ? list : []
      const current = entries.find((entry) => fbReadingMatchesWindow(entry, account.act, currentWindow)) ?? null
      const prior = entries.find((entry) => fbReadingMatchesWindow(entry, account.act, previousWindow)) ?? null
      return rowFromEntry(account, current, prior)
    }))
    if (id !== facebookLoad.current) return
    setFacebook(rows)
  }, [range])

  const loadTikTok = useCallback(async () => {
    const id = ++tiktokLoad.current
    setTiktokBusy(true)
    setTiktokFailure(null)
    try {
      const result = await window.electronAPI.ttReadingToday({ range })
      if (id !== tiktokLoad.current) return
      if ('ok' in result) {
        setTiktok(null)
        setTiktokFailure({ code: result.error, detail: result.detail })
      } else {
        setTiktok(result)
      }
    } catch {
      if (id !== tiktokLoad.current) return
      setTiktok(null)
      setTiktokFailure({ code: 'invoke-failed' })
    } finally {
      if (id === tiktokLoad.current) setTiktokBusy(false)
    }
  }, [range])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void loadFacebook().catch(() => {
      if (active) setFacebook([])
    })
    void loadTikTok()
    return () => {
      active = false
    }
  }, [loadFacebook, loadTikTok])

  const refreshFacebook = async (row: FacebookRow) => {
    if (!preset) return
    if (inChat) {
      setWorkspacePanel({ kind: 'browser' })
      return
    }
    setRefreshingAct(row.account.act)
    setRowFailure(null)
    try {
      const outcome = await refreshAccountWithRetry({
        alias: row.account.alias,
        act: row.account.act,
        businessId: row.account.businessId,
        range: preset
      }, {
        isCurrent: () => alive.current
      })
      if (outcome.kind === 'failed') setRowFailure({ act: row.account.act, code: outcome.error })
      await loadFacebook()
    } finally {
      setRefreshingAct(null)
    }
  }

  const captureAccount = async () => {
    setCaptureBusy(true)
    setCaptureError(null)
    try {
      const captured = await window.electronAPI.captureFbReadingAccount()
      if (!captured.ok || !captured.account) {
        setCaptureError(captureFailure(captured.error, t))
        return
      }
      const added = await window.electronAPI.addFbReadingAccounts({
        accounts: [{
          alias: captured.account.act,
          act: captured.account.act,
          businessId: captured.account.businessId
        }]
      })
      if (!added.ok) {
        setCaptureError(t('boards.today.captureFailed'))
        return
      }
      await loadFacebook()
    } finally {
      setCaptureBusy(false)
    }
  }

  const tiktokStep = (step: ReadingNextStep) => {
    if (step === 'connect' || step === 'reconnect' || step === 'pick-advertiser') navigate('/connections')
    else void loadTikTok()
  }

  const facebookStep = (step: ReadingNextStep, row: FacebookRow) => {
    if (step === 'open-browser') setWorkspacePanel({ kind: 'browser' })
    else void refreshFacebook(row)
  }

  const hasFigures =
    (facebook ?? []).some((row) => row.spend !== null) ||
    (tiktok?.accounts ?? []).some((account) => !isTikTokTodayFailure(account))

  // Fills a new chat's draft only; the user reads it and presses send.
  const ask = () => {
    if (!hasFigures) return
    const store = useAppStore.getState()
    store.setCurrentSessionId(null)
    store.setComposerPrefill(buildTodayChatPrompt(
      language === 'zh' ? 'zh' : 'en',
      t(rangeKey(range)),
      formatReadingWindow(dateWindow),
      chatRows(facebook, tiktok, tiktokFailure, preset !== null, t)
    ))
    navigate('/')
  }

  const rangeLabel = t(rangeKey(range))

  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col gap-6 overflow-y-auto px-8 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold leading-[34px] text-cream">{t('boards.today.title')}</h1>
          <p className="mt-1 text-[12px] leading-[18px] tabular-nums text-cream-faint">
            {rangeLabel} · {formatReadingWindow(dateWindow)}
            {previous ? ` · ${t('boards.today.compare').replace('{window}', formatReadingWindow(previous))}` : ''}
          </p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label={t('boards.today.title')}>
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={range === value}
              onClick={() => setRange(value)}
              className={`focus-ring rounded-full border px-3 py-1 text-[12px] leading-[18px] transition ${
                range === value
                  ? 'border-accent/60 bg-accent-soft text-accent'
                  : 'border-line text-cream-dim hover:text-cream'
              }`}
            >
              {t(rangeKey(value))}
            </button>
          ))}
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[16px] font-semibold leading-[26px] text-cream">{t('boards.today.facebook')}</h2>
        {facebook === null ? (
          <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.loading')}</p>
        ) : facebook.length === 0 ? (
          <div className="rounded-2xl border border-line bg-ink-850 px-4 py-4">
            <p className="text-[14px] leading-[22px] text-cream">{t('boards.today.noFacebook')}</p>
            <p className="mt-1 max-w-[52ch] text-[12px] leading-[18px] text-cream-faint">{t('boards.today.noFacebookHint')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setWorkspacePanel({ kind: 'browser' })}
                className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] leading-[18px] font-medium text-[rgb(var(--bg-app))]"
              >
                {t('boards.today.openBrowser')}
              </button>
              <button
                type="button"
                onClick={() => void captureAccount()}
                disabled={captureBusy}
                className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] leading-[18px] text-cream-dim hover:text-cream disabled:opacity-40"
              >
                {t('boards.today.capture')}
              </button>
            </div>
            {captureError && <p role="alert" className="mt-2 text-[12px] leading-[18px] text-red-600 dark:text-red-400">{captureError}</p>}
          </div>
        ) : (
          facebook.map((row) => (
            <FacebookAccount
              key={row.account.id}
              row={row}
              open={openAct === row.account.act}
              busy={refreshingAct === row.account.act}
              needsBrowser={inChat}
              failure={rowFailure?.act === row.account.act ? rowFailure.code : null}
              onToggle={() => setOpenAct((current) => current === row.account.act ? null : row.account.act)}
              onRefresh={() => void refreshFacebook(row)}
              onStep={(step) => facebookStep(step, row)}
              t={t}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[16px] font-semibold leading-[26px] text-cream">{t('boards.today.tiktok')}</h2>
        {tiktokFailure ? (
          <div className="rounded-2xl border border-line bg-ink-850 px-4 py-4">
            <ReadingErrorNotice
              notice={tiktokReadingNotice(tiktokFailure.code, t)}
              detail={tiktokFailure.detail}
              onAction={tiktokStep}
              busy={tiktokBusy}
            />
          </div>
        ) : tiktokBusy && !tiktok ? (
          <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.loading')}</p>
        ) : tiktok ? (
          <>
            {tiktok.accounts.map((account) => (
              <TikTokAccount
                key={account.advertiserId}
                account={account}
                generatedAt={tiktok.generatedAt}
                open={openTikTok === account.advertiserId}
                busy={tiktokBusy}
                onToggle={() => setOpenTikTok((current) => current === account.advertiserId ? null : account.advertiserId)}
                onStep={tiktokStep}
                t={t}
              />
            ))}
            {tiktok.truncated && (
              <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.truncated')}</p>
            )}
          </>
        ) : null}
      </section>

      <div className="flex flex-col items-start gap-2 pb-8">
        <button
          type="button"
          onClick={ask}
          disabled={!hasFigures}
          className="focus-ring rounded-full bg-accent px-4 py-2 text-[13px] font-medium leading-5 text-[rgb(var(--bg-app))] disabled:opacity-40"
        >
          {t('boards.today.ask')}
        </button>
        <p className="text-[12px] leading-[18px] text-cream-faint">
          {hasFigures ? t('boards.today.askHint') : t('boards.today.askDisabled')}
        </p>
        <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.currencyNote')}</p>
      </div>
    </div>
  )
}

function rowFromEntry(
  account: FbReadingAccountEntry,
  current: FbReadingHistoryEntry | null,
  prior: FbReadingHistoryEntry | null
): FacebookRow {
  const rows = current?.rows ?? []
  const priorRows = prior?.rows ?? []
  return {
    account,
    covered: true,
    spend: current?.totalSpend ?? null,
    previousSpend: prior?.totalSpend ?? null,
    impressions: sumFinite(rows.map((row) => row.impressions)),
    clicks: sumFinite(rows.map((row) => row.clicks)),
    conversions: sumFinite(rows.map((row) => row.results)),
    capturedAt: current?.capturedAt ?? null,
    movers: current
      ? topSpendMoves(
        rows.map((row) => ({ name: row.name, spend: row.spend ?? 0 })),
        prior ? priorRows.map((row) => ({ name: row.name, spend: row.spend ?? 0 })) : null,
        3
      )
      : []
  }
}

function rangeKey(range: TodayRange): I18nKey {
  if (range === 'today') return 'boards.today.range.today'
  if (range === 'last28') return 'boards.today.range.last28'
  return 'boards.today.range.last7'
}

function withCurrency(amount: string, currency: string | null): string {
  return currency ? `${amount} ${currency}` : amount
}

function chatRows(
  facebook: FacebookRow[] | null,
  tiktok: TikTokTodayReading | null,
  tiktokFailure: TikTokFailure | null,
  facebookCovered: boolean,
  t: Translate
) {
  const rows = []
  for (const row of facebook ?? []) {
    rows.push({
      platform: 'Facebook',
      name: row.account.alias,
      status: !facebookCovered
        ? t('boards.today.uncovered')
        : row.spend === null
          ? t('boards.today.noReading')
          : t('boards.today.verified'),
      spend: row.spend === null ? null : formatTikTokAmount(row.spend),
      delta: formatSpendDelta(row.spend, row.previousSpend),
      movers: row.movers.map((move) => `${move.name} ${formatSpendDelta(move.spend, move.previousSpend) ?? ''}`)
    })
  }
  if (tiktokFailure) {
    rows.push({
      platform: 'TikTok',
      name: t('boards.tt.allAdvertisers'),
      status: tiktokReadingNotice(tiktokFailure.code, t).message,
      spend: null,
      delta: null,
      movers: []
    })
  }
  for (const account of tiktok?.accounts ?? []) {
    const name = account.name ?? account.advertiserId
    if (isTikTokTodayFailure(account)) {
      rows.push({
        platform: 'TikTok',
        name,
        status: tiktokReadingNotice(account.error, t).message,
        spend: null,
        delta: null,
        movers: []
      })
      continue
    }
    rows.push({
      platform: 'TikTok',
      name,
      status: t('boards.today.official'),
      spend: withCurrency(formatTikTokAmount(account.spend), account.currency),
      delta: formatSpendDelta(account.spend, account.previousSpend),
      movers: account.campaigns.map((move) => `${move.name} ${formatSpendDelta(move.spend, move.previousSpend) ?? ''}`)
    })
  }
  return rows
}

function Movers({
  movers,
  t
}: {
  movers: TodayCampaignMove[]
  t: (key: I18nKey) => string
}) {
  if (movers.length === 0) {
    return <p className="mt-2 text-[12px] leading-[18px] text-cream-faint">{t('boards.today.noMovers')}</p>
  }
  return (
    <ul className="mt-2 flex flex-col gap-1">
      <li className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.movers')}</li>
      {movers.map((move) => (
        <li key={move.name} className="flex items-baseline justify-between gap-3 text-[12px] leading-[18px]">
          <span className="min-w-0 truncate text-cream-dim" title={move.name}>{move.name}</span>
          <span className="shrink-0 tabular-nums text-cream">
            {formatTikTokAmount(move.spend)}
            {move.delta !== null ? ` ${formatSpendDelta(move.spend, move.previousSpend) ?? ''}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

function TikTokAccount({
  account,
  generatedAt,
  open,
  busy,
  onToggle,
  onStep,
  t
}: {
  account: TikTokTodayAccount
  generatedAt: number
  open: boolean
  busy: boolean
  onToggle: () => void
  onStep: (step: ReadingNextStep) => void
  t: Translate
}) {
  const title = (
    <div className="min-w-0">
      <p className="truncate text-[14px] leading-[22px] text-cream" title={account.advertiserId}>
        {account.name ?? account.advertiserId}
      </p>
      <p className="truncate text-[12px] leading-[18px] tabular-nums text-cream-faint">
        {account.name ? `ID ${account.advertiserId} · ` : ''}
        {t('boards.today.official')}
        {' · '}
        {t('boards.reading.updatedAt', { time: new Date(generatedAt).toLocaleString() })}
      </p>
    </div>
  )
  if (isTikTokTodayFailure(account)) {
    return (
      <article className="rounded-2xl border border-line bg-ink-850 px-4 py-3">
        {title}
        <ReadingErrorNotice
          className="mt-2"
          notice={tiktokReadingNotice(account.error, t)}
          detail={account.detail}
          onAction={onStep}
          busy={busy}
        />
      </article>
    )
  }
  const delta = formatSpendDelta(account.spend, account.previousSpend)
  return (
    <article className="rounded-2xl border border-line bg-ink-850 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        {title}
        <div className="text-right">
          <p className="text-[20px] font-semibold leading-7 tabular-nums text-cream">
            {formatTikTokAmount(account.spend)}
            {account.currency && <span className="ml-1 text-[12px] font-normal text-cream-faint">{account.currency}</span>}
          </p>
          <p className="text-[12px] leading-[18px] tabular-nums text-cream-dim">
            {delta ?? t('boards.today.noPrevious')}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="focus-ring mt-2 flex items-center gap-1 text-[12px] leading-[18px] text-cream-faint"
      >
        <ChevronDown size={12} className={open ? 'rotate-180' : ''} />
        {open ? t('boards.today.collapse') : t('boards.today.expand')}
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-3 border-t border-line pt-2 sm:grid-cols-4">
          <Metric label={t('boards.tt.metric.impressions')} value={formatTikTokCount(account.impressions)} />
          <Metric label={t('boards.tt.metric.clicks')} value={formatTikTokCount(account.clicks)} />
          <Metric label={t('boards.tt.metric.ctr')} value={formatTikTokRate(account.clicks, account.impressions)} />
          <Metric label={t('boards.tt.metric.conversions')} value={formatTikTokCount(account.conversions)} />
          <Metric
            label={t('boards.tt.metric.costPerConversion')}
            value={formatTikTokCostPerConversion(account.spend, account.conversions)}
          />
        </div>
      )}
      <Movers movers={account.campaigns} t={t} />
    </article>
  )
}

function FacebookAccount({
  row,
  open,
  busy,
  needsBrowser,
  failure,
  onToggle,
  onRefresh,
  onStep,
  t
}: {
  row: FacebookRow
  open: boolean
  busy: boolean
  needsBrowser: boolean
  failure: string | null
  onToggle: () => void
  onRefresh: () => void
  onStep: (step: ReadingNextStep) => void
  t: Translate
}) {
  const delta = formatSpendDelta(row.spend, row.previousSpend)
  const notice: ReadingNotice | null = failure ? fbReadingNotice(failure, t, 'boards.today.refreshFailed') : null
  return (
    <article className="rounded-2xl border border-line bg-ink-850 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] leading-[22px] text-cream">{row.account.alias}</p>
          <p className="text-[12px] leading-[18px] text-cream-faint">
            {!row.covered
              ? t('boards.today.uncovered')
              : row.capturedAt
                ? `${t('boards.today.verified')} · ${t('boards.reading.updatedAt', { time: new Date(row.capturedAt).toLocaleString() })}`
                : t('boards.today.noReading')}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[20px] font-semibold leading-7 tabular-nums text-cream">
            {row.spend === null ? '—' : formatTikTokAmount(row.spend)}
          </p>
          <p className="text-[12px] leading-[18px] tabular-nums text-cream-dim">
            {row.covered ? (delta ?? t('boards.today.noPrevious')) : '—'}
          </p>
        </div>
      </div>
      {notice && failure && (
        <ReadingErrorNotice className="mt-2" notice={notice} detail={failure} onAction={onStep} busy={busy} />
      )}
      {row.covered && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="focus-ring flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] leading-[18px] text-cream-dim disabled:opacity-40"
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            {needsBrowser ? t('boards.today.openBrowser') : busy ? t('boards.reading.refreshing') : t('boards.today.refresh')}
          </button>
          {row.spend !== null && (
            <button type="button" onClick={onToggle} className="focus-ring flex items-center gap-1 text-[12px] leading-[18px] text-cream-faint">
              <ChevronDown size={12} className={open ? 'rotate-180' : ''} />
              {open ? t('boards.today.collapse') : t('boards.today.expand')}
            </button>
          )}
        </div>
      )}
      {open && row.spend !== null && (
        <div className="mt-2 grid grid-cols-2 gap-3 border-t border-line pt-2 sm:grid-cols-4">
          <Metric label={t('boards.tt.metric.impressions')} value={row.impressions === null ? '—' : formatTikTokCount(row.impressions)} />
          <Metric label={t('boards.tt.metric.clicks')} value={row.clicks === null ? '—' : formatTikTokCount(row.clicks)} />
          <Metric
            label={t('boards.tt.metric.ctr')}
            value={row.impressions === null || row.clicks === null ? '—' : formatTikTokRate(row.clicks, row.impressions)}
          />
          <Metric
            label={t('boards.tt.metric.costPerConversion')}
            value={formatTikTokCostPerConversion(row.spend ?? 0, row.conversions ?? 0)}
          />
        </div>
      )}
      {row.covered && row.spend !== null && <Movers movers={row.movers} t={t} />}
    </article>
  )
}
