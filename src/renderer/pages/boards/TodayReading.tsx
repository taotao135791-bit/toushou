import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, RefreshCw } from 'lucide-react'
import type { KanbanBoard } from '@shared/types'
import type { ReadingSnapshot } from '@shared/readingSnapshot'
import type { ReadingErrorCode } from '@shared/readingError'
import {
  fbPresetForTodayRange,
  formatReadingWindow,
  formatSpendDelta,
  isTikTokTodayFailure,
  previousEqualWindow,
  todayWindow,
  todayWindowForAccountDate,
  parseTikTokCustomWindow,
  TIKTOK_CUSTOM_MAX_DAYS,
  type TikTokTodayAccount,
  type TikTokTodayAccountReading,
  type TodayCampaignMove,
  type TodayRange,
  type TikTokTodayRange,
  type TikTokTodayReading
} from '@shared/todayReading'
import { formatTikTokAmount, formatTikTokCostPerConversion, formatTikTokCount, formatTikTokRate, tiktokAccountDate } from '@shared/tiktokReport'
import { useT, type I18nKey } from '../../i18n'
import { useAppStore } from '../../store'
import { refreshAccountWithRetry } from './fbReadingRefresh'
import { loadTodayFacebookAccounts, type TodayFacebookRow as FacebookRow } from './todayFacebook'
import { ReadingDraftDialog } from './ReadingDraftDialog'
import { SaveReadingBoardDialog } from './SaveReadingBoardDialog'
import { snapshotToday, anonymousReadingDraft } from './todaySnapshot'
import { isTikTokAccountCurrent } from './readingFreshness'
import { TTReadingProgress, type TTProgress } from './TTReadingProgress'
import { TikTokAccountPicker } from './TikTokAccountPicker'
import { buildTikTokAccountDraft } from './tiktokAccountDraft'
import { mergeSingleTikTokReading } from './tiktokAccountRefresh'
import { buildTikTokPageRead, matchesTikTokPageRead, scopeTikTokPageData, type TikTokPageScope } from './tiktokTodayScope'
import {
  ReadingErrorNotice,
  fbReadingNotice,
  tiktokReadingNotice,
  type ReadingNextStep,
  type ReadingNotice
} from './ReadingErrorNotice'

const RANGES: TodayRange[] = ['today', 'last7', 'last28']

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string


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

export function TodayReading({ onSaved }: { onSaved?: (board: KanbanBoard) => void } = {}) {
  const t = useT()
  const navigate = useNavigate()
  const language = useAppStore((state) => state.language)
  const inChat = useAppStore((state) => state.workspacePanel) === null
  const setWorkspacePanel = useAppStore((state) => state.setWorkspacePanel)
  const [range, setRange] = useState<TikTokTodayRange>('last7')
  const [customWindow, setCustomWindow] = useState(todayWindow('last7'))
  const [startInput, setStartInput] = useState(customWindow.start)
  const [endInput, setEndInput] = useState(customWindow.end)
  const [dateError, setDateError] = useState(false)
  const [facebookLoadedKey, setFacebookLoadedKey] = useState('')
  const [facebookLoading, setFacebookLoading] = useState(true)
  const [facebookLoadError, setFacebookLoadError] = useState(false)
  const [saveSnapshot, setSaveSnapshot] = useState<ReadingSnapshot | null>(null)
  const [localMappings, setLocalMappings] = useState<{ label: string; name: string }[]>([])
  const [facebook, setFacebook] = useState<FacebookRow[] | null>(null)
  const [tiktok, setTiktok] = useState<TikTokTodayReading | null>(null)
  const [tiktokFailure, setTiktokFailure] = useState<TikTokFailure | null>(null)
  const [tiktokBusy, setTiktokBusy] = useState(false)
  const [refreshingAct, setRefreshingAct] = useState<string | null>(null)
  const [rowFailures, setRowFailures] = useState<Record<string, string | null>>({})
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureBusy, setCaptureBusy] = useState(false)
  const [openAct, setOpenAct] = useState<string | null>(null)
  const [resultQuery, setResultQuery] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [sortSpend, setSortSpend] = useState(false)
  const [openTikTok, setOpenTikTok] = useState<string | null>(null)
  const facebookLoad = useRef(0)
  const facebookRefresh = useRef(0)
  const facebookContext = useRef('')
  const tiktokLoad = useRef(0)
  const tiktokRequest = useRef<string | null>(null)
  const ttPageScopeRef = useRef<TikTokPageScope | null>(null)
  const [ttPageScope, setTtPageScope] = useState<TikTokPageScope | null>(null)
  const [ttProgress, setTtProgress] = useState<TTProgress | null>(null)
  const [ttCancelling, setTtCancelling] = useState(false)
  const singleRequest = useRef<{ advertiserId: string; requestId: string } | null>(null)
  const [singleActive, setSingleActive] = useState<string | null>(null)
  const [singleProgress, setSingleProgress] = useState<TTProgress | null>(null)
  const [singleCancelling, setSingleCancelling] = useState(false)
  const [singleFailures, setSingleFailures] = useState<Record<string, TikTokFailure | null>>({})
  const [singleUpdatedAt, setSingleUpdatedAt] = useState<Record<string, number>>({})
  const [singleSyncError, setSingleSyncError] = useState<Record<string, string | null>>({})
  const [singleDraft, setSingleDraft] = useState<string | null>(null)
  const [singleDraftCopy, setSingleDraftCopy] = useState<'copied' | 'failed' | null>(null)

  useEffect(() => window.electronAPI.onTtReadingProgress?.((event) => {
    if (event.requestId === tiktokRequest.current) {
      setTtProgress(event)
      if (event.today) {
        const partial = event.today
        setTiktok(current => ({
          range: partial.range, window: partial.window, previousWindow: partial.previousWindow,
          source: partial.source, generatedAt: partial.generatedAt, truncated: false,
          accounts: [...(current?.accounts ?? []).filter(a => a.advertiserId !== partial.account.advertiserId), partial.account],
          datasetSync: { ok: false, error: 'reading-in-progress' }
        }))
      }
    }
    if (event.requestId === singleRequest.current?.requestId) setSingleProgress(event)
  }), [])
  const alive = useRef(true)

  const zh = language === 'zh'
  const dateWindow = range === 'custom' ? customWindow : todayWindow(range)
  const previous = previousEqualWindow(dateWindow)
  const preset = range === 'custom' ? null : fbPresetForTodayRange(range)
  const facebookKey = `${dateWindow.start}|${dateWindow.end}`
  facebookContext.current = facebookKey
  const visibleFacebook = facebookLoadedKey === facebookKey ? facebook : null
  const facebookPending = facebookLoading || facebookLoadedKey !== facebookKey

  const loadFacebook = useCallback(async () => {
    const expected = range === 'custom' ? customWindow : todayWindow(range)
    const key = `${expected.start}|${expected.end}`
    if (facebookContext.current !== key) return
    const id = ++facebookLoad.current
    setFacebookLoading(true)
    setFacebookLoadError(false)
    try {
      const accounts = await window.electronAPI.listFbReadingAccounts()
      if (id !== facebookLoad.current || facebookContext.current !== key) return
      const rows = await loadTodayFacebookAccounts(accounts, range === 'custom' ? 'last7' : range,
        (accountId) => window.electronAPI.listFbReadings({ accountId }), new Date(), range === 'custom' ? customWindow : !fbPresetForTodayRange(range) ? todayWindow(range) : undefined)
      if (id === facebookLoad.current && facebookContext.current === key) { setFacebook(rows); setFacebookLoadedKey(key) }
    } catch {
      if (id === facebookLoad.current && facebookContext.current === key) { setFacebookLoadError(true); setFacebook([]); setFacebookLoadedKey(key) }
    } finally { if (id === facebookLoad.current && facebookContext.current === key) setFacebookLoading(false) }
  }, [range, customWindow.start, customWindow.end])

  const loadTikTok = useCallback(async (scope: TikTokPageScope) => {
    if (singleRequest.current) void window.electronAPI.ttReadingCancel?.(singleRequest.current.requestId)
    singleRequest.current = null
    setSingleActive(null)
    setSingleFailures({})
    setSingleUpdatedAt({})
    setSingleSyncError({})
    const previousRequest = tiktokRequest.current
    if (previousRequest) void window.electronAPI.ttReadingCancel?.(previousRequest)
    const requestId = crypto.randomUUID()
    tiktokRequest.current = requestId
    setTtProgress(null)
    setTtCancelling(false)
    const id = ++tiktokLoad.current
    setTiktokBusy(true)
    setTiktok(null)
    setTiktokFailure(null)
    try {
      const input = buildTikTokPageRead(scope, range, requestId, customWindow)
      if (!input) return
      const result = await window.electronAPI.ttReadingToday(input)
      if (id !== tiktokLoad.current) return
      if ('ok' in result) {
        setTiktok(null)
        setTiktokFailure({ code: result.error, detail: result.detail })
      } else if (!matchesTikTokPageRead(scope, range, result, customWindow)) {
        setTiktok(null)
        setTiktokFailure({ code: 'api', detail: 'single-result-invalid' })
      } else {
        setTiktok(result)
      }
    } catch {
      if (id !== tiktokLoad.current) return
      setTiktok(null)
      setTiktokFailure({ code: 'invoke-failed' })
    } finally {
      if (id === tiktokLoad.current) { tiktokRequest.current = null; setTiktokBusy(false); setTtCancelling(false) }
    }
  }, [range, customWindow.start, customWindow.end])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    facebookRefresh.current += 1
    setRefreshingAct(null)
    setRowFailures({})
    void loadFacebook().catch(() => {
      if (active) setFacebook([])
    })
    if (ttPageScopeRef.current) void loadTikTok(ttPageScopeRef.current)
    return () => {
      active = false
      tiktokLoad.current += 1
      if (tiktokRequest.current) void window.electronAPI.ttReadingCancel?.(tiktokRequest.current)
      tiktokRequest.current = null
      if (singleRequest.current) void window.electronAPI.ttReadingCancel?.(singleRequest.current.requestId)
      singleRequest.current = null
    }
  }, [loadFacebook, loadTikTok])

  const refreshFacebook = async (row: FacebookRow) => {
    if (refreshingAct) return
    const key = facebookContext.current
    const refreshId = ++facebookRefresh.current
    const isCurrent = () => alive.current && key === facebookContext.current && refreshId === facebookRefresh.current
    if (inChat) {
      setWorkspacePanel({ kind: 'browser' })
      return
    }
    setRefreshingAct(row.account.act)
    setRowFailures((old) => ({ ...old, [row.account.act]: null }))
    try {
      const outcome = await refreshAccountWithRetry({
        alias: row.account.alias,
        act: row.account.act,
        businessId: row.account.businessId,
        range: preset ?? 'custom',
        ...(!preset ? { startDate: dateWindow.start, endDate: dateWindow.end } : {})
      }, {
        isCurrent
      })
      if (!isCurrent()) return
      if (outcome.kind === 'failed') setRowFailures((old) => ({ ...old, [row.account.act]: outcome.error }))
      await loadFacebook()
    } finally {
      if (isCurrent()) setRefreshingAct(null)
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

  const cancelTikTok = async () => {
    const requestId = tiktokRequest.current
    if (!requestId || !window.electronAPI.ttReadingCancel) return
    const cancelled = await window.electronAPI.ttReadingCancel(requestId).catch(() => false)
    if (!cancelled || tiktokRequest.current !== requestId) return
    setTtCancelling(true)
  }

  const refreshTikTokAccount = async (advertiserId: string) => {
    if (tiktokBusy || singleRequest.current || !tiktok || tiktok.range !== range) return
    const requestId = crypto.randomUUID()
    singleRequest.current = { advertiserId, requestId }
    setSingleActive(advertiserId)
    setSingleProgress(null)
    setSingleCancelling(false)
    setSingleFailures((current) => ({ ...current, [advertiserId]: null }))
    setSingleSyncError((current) => ({ ...current, [advertiserId]: null }))
    try {
      const result = await window.electronAPI.ttReadingToday({ range, advertiserId, requestId, ...(range === 'custom' ? { startDate: customWindow.start, endDate: customWindow.end } : {}) })
      if (singleRequest.current?.requestId !== requestId) return
      if ('ok' in result) {
        setSingleFailures((current) => ({ ...current, [advertiserId]: { code: result.error, detail: result.detail } }))
        return
      }
      const returned = result.accounts.length === 1 && result.accounts[0].advertiserId === advertiserId ? result.accounts[0] : null
      if (!returned || isTikTokTodayFailure(returned)) {
        setSingleFailures((current) => ({ ...current, [advertiserId]: returned && isTikTokTodayFailure(returned) ? { code: returned.error, detail: returned.detail } : { code: 'api', detail: 'single-result-invalid' } }))
        return
      }
      const merged = mergeSingleTikTokReading(tiktok, result, advertiserId)
      if (!merged) {
        setSingleFailures((current) => ({ ...current, [advertiserId]: { code: 'api', detail: 'single-result-invalid' } }))
        return
      }
      setTiktok((current) => current && current.range === range ? mergeSingleTikTokReading(current, result, advertiserId) ?? current : current)
      setSingleUpdatedAt((current) => ({ ...current, [advertiserId]: result.generatedAt }))
      if (result.datasetSync?.ok === false) setSingleSyncError((current) => ({ ...current, [advertiserId]: result.datasetSync && !result.datasetSync.ok ? result.datasetSync.error : null }))
    } catch {
      if (singleRequest.current?.requestId === requestId) setSingleFailures((current) => ({ ...current, [advertiserId]: { code: 'invoke-failed' } }))
    } finally {
      if (singleRequest.current?.requestId === requestId) {
        singleRequest.current = null
        setSingleActive(null)
        setSingleCancelling(false)
      }
    }
  }

  const cancelSingleTikTok = async () => {
    const request = singleRequest.current
    if (!request || !window.electronAPI.ttReadingCancel) return
    const cancelled = await window.electronAPI.ttReadingCancel(request.requestId).catch(() => false)
    if (cancelled && singleRequest.current?.requestId === request.requestId) setSingleCancelling(true)
  }

  const analyzeTikTokAccount = (account: TikTokTodayAccountReading) => {
    if (!tiktok || tiktok.range !== range || singleFailures[account.advertiserId] || singleActive === account.advertiserId) return
    const currentWindow = account.window ?? tiktok.window
    const previousWindow = account.previousWindow ?? tiktok.previousWindow
    const accountDay = tiktokAccountDate(Date.now(), account.timezone)
    const expected = range === 'custom' ? customWindow : accountDay ? todayWindowForAccountDate(range, accountDay) : null
    const current = !!expected && currentWindow.start === expected.start && currentWindow.end === expected.end
    if (!current) {
      setSingleFailures((old) => ({ ...old, [account.advertiserId]: { code: 'api', detail: 'reading-window-expired' } }))
      return
    }
    setLocalMappings([{ label: zh ? '所选 TikTok 账户' : 'Selected TikTok account', name: account.name ?? account.advertiserId }, ...account.campaigns.slice(0, 3).map((move, i) => ({ label: `${zh ? '活动' : 'Campaign'} ${String.fromCharCode(65 + i)}`, name: move.name }))])
    setSingleDraft(buildTikTokAccountDraft(language === 'zh' ? 'zh' : 'en', account, currentWindow, previousWindow, singleUpdatedAt[account.advertiserId] ?? tiktok.generatedAt))
    setSingleDraftCopy(null)
  }

  const copySingleDraft = async () => {
    if (singleDraft === null) return
    try { await navigator.clipboard.writeText(singleDraft); setSingleDraftCopy('copied') }
    catch { setSingleDraftCopy('failed') }
  }

  const chooseTikTokScope = (scope: TikTokPageScope) => {
    ttPageScopeRef.current = scope
    setTtPageScope(scope)
    void loadTikTok(scope)
  }

  const tiktokStep = (step: ReadingNextStep) => {
    if (step === 'pick-date') { document.getElementById('today-start-date')?.focus(); return }
    if (step === 'connect' || step === 'reconnect' || step === 'pick-advertiser') navigate('/connections')
    else if (ttPageScopeRef.current) void loadTikTok(ttPageScopeRef.current)
  }

  const facebookStep = (step: ReadingNextStep, row: FacebookRow) => {
    if (step === 'open-browser') setWorkspacePanel({ kind: 'browser' })
    else void refreshFacebook(row)
  }

  const scopedTikTok = () => {
    const scoped = scopeTikTokPageData(tiktok?.range === range ? tiktok : null, ttPageScope)
    return scoped ? { ...scoped, accounts: scoped.accounts.map(account => isTikTokTodayFailure(account) || isTikTokAccountCurrent(account, scoped, range, customWindow) ? account : { advertiserId: account.advertiserId, name: account.name, currency: account.currency, timezone: account.timezone, error: 'api' as const, detail: 'reading-window-expired' }) } : null
  }
  const currentTikTok = scopedTikTok()
  const displayedTikTok = [...(currentTikTok?.accounts ?? [])].filter(account =>
    (!onlyFailed || isTikTokTodayFailure(account) || !!singleFailures[account.advertiserId]) &&
    (!resultQuery.trim() || `${account.name ?? ''} ${account.advertiserId}`.toLowerCase().includes(resultQuery.trim().toLowerCase())))
  if (sortSpend) displayedTikTok.sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? '') || (isTikTokTodayFailure(b) ? -1 : isTikTokTodayFailure(a) ? 1 : b.spend - a.spend))
  const failedAccountIds = new Set(Object.entries(singleFailures).filter(([, failure]) => !!failure).map(([id]) => id))
  if (singleActive) failedAccountIds.add(singleActive)
  const draftTikTok = scopeTikTokPageData(currentTikTok, ttPageScope, failedAccountIds)
  const goodFacebook = (visibleFacebook ?? []).filter(row => !rowFailures[row.account.act] && !row.readError && refreshingAct !== row.account.act)
  const hasFigures = goodFacebook.some(row => row.spend !== null) || (draftTikTok?.accounts ?? []).some(account => !isTikTokTodayFailure(account))
  const rangeLabel = range === 'custom' ? (zh ? '自选日期' : 'Custom dates') : t(rangeKey(range))
  const currentSnapshot = () => snapshotToday({ rangeLabel, window: dateWindow, capturedAt: Date.now(), facebook: visibleFacebook,
    tiktok: scopedTikTok(), facebookLoadError, tiktokFailure, facebookFailures: rowFailures, tiktokFailures: singleFailures, updatedAt: singleUpdatedAt })
  const ask = () => {
    if (!hasFigures || tiktokBusy || facebookPending || refreshingAct || singleActive) return
    const draft = anonymousReadingDraft(snapshotToday({ rangeLabel, window: dateWindow, capturedAt: Date.now(),
      facebook: goodFacebook, facebookLoadError, tiktokFailure, tiktok: scopeTikTokPageData(scopedTikTok(), ttPageScope, failedAccountIds) }), zh ? 'zh' : 'en')
    setLocalMappings(draft.mappings.map(text => { const [label, ...name] = text.split(' → '); return { label, name: name.join(' → ') } }))
    setSingleDraft(draft.text); setSingleDraftCopy(null)
  }
  const applyDates = () => {
    const next = parseTikTokCustomWindow(startInput, endInput)
    if (!next) { setDateError(true); return }
    setDateError(false); setSingleDraft(null)
    if (range === 'custom' && customWindow.start === next.start && customWindow.end === next.end) {
      void loadFacebook()
      if (ttPageScopeRef.current) void loadTikTok(ttPageScopeRef.current)
    } else { setCustomWindow(next); setRange('custom') }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[880px] flex-col gap-6 overflow-y-auto px-8 py-8">
      {singleDraft !== null && <ReadingDraftDialog title={t('boards.today.singleDraftTitle')} language={zh ? 'zh' : 'en'} value={singleDraft} copyState={singleDraftCopy} localMappings={localMappings} onChange={(value) => { setSingleDraft(value); setSingleDraftCopy(null) }} onClose={() => setSingleDraft(null)} onCopy={() => void copySingleDraft()} />}
      {saveSnapshot && <SaveReadingBoardDialog snapshot={saveSnapshot} language={zh ? 'zh' : 'en'} onClose={() => setSaveSnapshot(null)} onSaved={(board) => { setSaveSnapshot(null); onSaved?.(board) }} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold leading-[34px] text-cream">{t('boards.today.title')}</h1>
          <p className="mt-1 text-[12px] leading-[18px] tabular-nums text-cream-faint">
            {rangeLabel} · {formatReadingWindow(dateWindow)}
            <span> · {zh ? 'Facebook 按来源日期；TikTok 快捷范围按账户时区，详见账户行' : 'Facebook uses source dates; TikTok presets use account timezones, shown per account'}</span>
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
              onClick={() => { const window = todayWindow(value); setStartInput(window.start); setEndInput(window.end); setDateError(false); setSingleDraft(null); setRange(value) }}
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

      <form onSubmit={e => { e.preventDefault(); applyDates() }} className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-3">
        <label className="flex flex-col gap-1 text-[12px] text-cream-dim">{zh ? '开始日期' : 'Start date'}<input id="today-start-date" aria-label={zh ? '开始日期' : 'Start date'} type="date" value={startInput} onChange={e => setStartInput(e.target.value)} className="rounded-lg border border-line bg-ink-850 px-2 py-1.5 text-cream" /></label>
        <label className="flex flex-col gap-1 text-[12px] text-cream-dim">{zh ? '结束日期' : 'End date'}<input aria-label={zh ? '结束日期' : 'End date'} type="date" value={endInput} onChange={e => setEndInput(e.target.value)} className="rounded-lg border border-line bg-ink-850 px-2 py-1.5 text-cream" /></label>
        <button type="submit" className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream">{zh ? '应用日期' : 'Apply dates'}</button>
        <p className="w-full text-[12px] text-cream-faint">{zh ? `可选单日或起止日期，每次最多 ${TIKTOK_CUSTOM_MAX_DAYS} 天。TikTok 按账户校验日期；Facebook 仅展示与日期完全匹配的读数。` : `Choose a day or a range up to ${TIKTOK_CUSTOM_MAX_DAYS} days. Dates are checked per TikTok account; Facebook only shows exact matching readings.`}</p>
        {dateError && <p role="alert" className="text-[12px] text-red-600">{zh ? '日期无效、开始晚于结束，或范围过长。' : 'Invalid dates, reversed range, or range too long.'}</p>}
      </form>
      {range === 'today' && <p role="note" className="text-[12px] text-amber-700 dark:text-amber-300">{zh ? '今天的数据截至读取时，比较项为昨天全天，两者不是等时段。' : 'Today is measured at read time; the comparison is the whole of yesterday. These are not equal elapsed periods.'}</p>}
      <section className="flex flex-col gap-2">
        <h2 className="text-[16px] font-semibold leading-[26px] text-cream">{t('boards.today.facebook')}</h2>
        {facebookLoadError ? <div role="alert" className="rounded-xl border border-line p-4 text-[13px] text-cream"><p>{zh ? '无法加载 Facebook 账户或历史读数。' : 'Could not load Facebook accounts or history.'}</p><button onClick={() => void loadFacebook()} className="focus-ring mt-2 rounded-full border border-line px-3 py-1">{zh ? '重试' : 'Retry'}</button></div> : visibleFacebook === null ? (
          <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.loading')}</p>
        ) : visibleFacebook.length === 0 ? (
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
          visibleFacebook.map((row) => (
            <FacebookAccount
              key={row.account.id}
              row={row}
              open={openAct === row.account.act}
              busy={refreshingAct === row.account.act}
              needsBrowser={inChat}
              refreshDisabled={refreshingAct !== null}
              failure={rowFailures[row.account.act] ?? row.readError}
              onToggle={() => setOpenAct((current) => current === row.account.act ? null : row.account.act)}
              onRefresh={() => void refreshFacebook(row)}
              onStep={(step) => row.readError ? void loadFacebook() : facebookStep(step, row)}
              t={t}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[16px] font-semibold leading-[26px] text-cream">{t('boards.today.tiktok')}</h2>
        <TikTokAccountPicker
          busy={tiktokBusy || singleActive !== null}
          onReadOne={(advertiserId) => chooseTikTokScope({ kind: 'one', advertiserId })}
          onReadAll={() => chooseTikTokScope({ kind: 'all' })}
          onConnect={() => navigate('/connections')}
          labels={{
            connect: zh ? '连接 TikTok' : 'Connect TikTok', title: t('boards.today.ttPicker.title'), description: t('boards.today.ttPicker.description'),
            accountLabel: t('boards.today.ttPicker.accountLabel'), accountPlaceholder: t('boards.today.ttPicker.placeholder'),
            manualHint: t('boards.today.ttPicker.manualHint'), loading: t('boards.today.ttPicker.loading'), empty: t('boards.today.ttPicker.empty'),
            discoveryError: t('boards.today.ttPicker.error'), namesIncomplete: t('boards.today.ttPicker.namesIncomplete'), noMatch: t('boards.today.ttPicker.noMatch'),
            retry: t('boards.today.ttPicker.retry'), invalidId: t('boards.today.ttPicker.invalid'),
            readOne: t('boards.today.ttPicker.readOne'), readAll: t('boards.today.ttPicker.readAll'), readAllHint: t('boards.today.ttPicker.readAllHint')
          }}
        />
        {ttPageScope && <p className="text-[12px] text-cream-faint">{t(ttPageScope.kind === 'one' ? 'boards.today.ttPicker.currentOne' : 'boards.today.ttPicker.currentAll')}</p>}
        {currentTikTok?.cancelled && <p role="status" className="text-[12px] text-cream-dim">{zh ? '已取消。已完成的账户保留，未读取项单独标记；本次未覆盖数据集。' : 'Cancelled. Completed accounts are retained; unread accounts are marked. The dataset was not replaced.'}</p>}
        {tiktokBusy && <TTReadingProgress progress={ttProgress} cancelling={ttCancelling} onCancel={() => void cancelTikTok()} />}
        {tiktokFailure ? (
          <div className="rounded-2xl border border-line bg-ink-850 px-4 py-4">
            <ReadingErrorNotice
              notice={tiktokReadingNotice(tiktokFailure.code, t, tiktokFailure.detail)}
              detail={tiktokFailure.detail}
              onAction={tiktokStep}
              busy={tiktokBusy}
            />
          </div>
        ) : tiktokBusy && !currentTikTok ? (
          <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.loading')}</p>
        ) : currentTikTok ? (
          <>
            {currentTikTok.datasetSync?.ok === false && !tiktokBusy && !['reading-in-progress', 'reading-cancelled'].includes(currentTikTok.datasetSync.error) && <p role="status" className="text-[12px] text-amber-700 dark:text-amber-300">{t(currentTikTok.datasetSync.error === 'superseded' ? 'boards.datasets.syncSuperseded' : currentTikTok.datasetSync.error === 'proof-failed' ? 'boards.datasets.proofFailed' : currentTikTok.datasetSync.error === 'row-limit' ? 'boards.datasets.ttRowLimit' : 'boards.datasets.syncFailed')}</p>}
            {currentTikTok.datasetSync?.ok === true && Boolean(currentTikTok.datasetSync.legacyBackups?.length) && <p role="status" className="text-[12px] text-amber-700 dark:text-amber-300">{t('boards.tt.backupNotice', {names:currentTikTok.datasetSync.legacyBackups!.join('、')})}</p>}
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-cream-dim">
              <input type="search" aria-label={zh ? '筛选巡检结果' : 'Filter inspection results'} placeholder={zh ? '筛选账户名或 ID' : 'Filter account name or ID'} value={resultQuery} onChange={e => setResultQuery(e.target.value)} className="rounded-lg border border-line bg-ink-850 px-3 py-1.5 text-cream" />
              <label className="flex items-center gap-1"><input type="checkbox" checked={onlyFailed} onChange={e => setOnlyFailed(e.target.checked)} />{zh ? '仅失败或未读取' : 'Failed or unread only'}</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={sortSpend} onChange={e => setSortSpend(e.target.checked)} />{zh ? '按币种分组后消耗排序' : 'Sort spend within each currency'}</label>
              <span role="status">{zh ? `显示 ${displayedTikTok.length} / ${currentTikTok.accounts.length} 个账户；列表筛选不改变保存范围。` : `Showing ${displayedTikTok.length} / ${currentTikTok.accounts.length} accounts; filtering does not change the saved scope.`}</span>
            </div>
            {displayedTikTok.length === 0 && <p className="text-[12px] text-cream-faint">{zh ? '没有匹配的账户。' : 'No matching accounts.'}</p>}
            {displayedTikTok.map((account) => (
              <TikTokAccount
                key={account.advertiserId}
                account={account}
                generatedAt={singleUpdatedAt[account.advertiserId] ?? currentTikTok.generatedAt}
                open={openTikTok === account.advertiserId}
                busy={tiktokBusy || singleActive === account.advertiserId}
                refreshDisabled={tiktokBusy || singleActive !== null || currentTikTok.range !== range}
                failure={singleFailures[account.advertiserId] ?? null}
                syncError={singleSyncError[account.advertiserId] ?? null}
                progress={singleActive === account.advertiserId ? singleProgress : null}
                cancelling={singleActive === account.advertiserId && singleCancelling}
                onCancel={() => void cancelSingleTikTok()}
                onRefresh={() => void refreshTikTokAccount(account.advertiserId)}
                onAnalyze={() => { if (!isTikTokTodayFailure(account)) analyzeTikTokAccount(account) }}
                onToggle={() => setOpenTikTok((current) => current === account.advertiserId ? null : account.advertiserId)}
                onStep={(step) => step === 'retry' ? void refreshTikTokAccount(account.advertiserId) : tiktokStep(step)}
                t={t}
              />
            ))}
            {currentTikTok.truncated && (
              <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.truncated')}</p>
            )}
          </>
        ) : null}
      </section>

      <div className="flex flex-col items-start gap-2 pb-8">
        <button type="button" onClick={() => { if (!facebookPending && !tiktokBusy && !refreshingAct && !singleActive) setSaveSnapshot(currentSnapshot()) }} disabled={tiktokBusy || facebookPending || refreshingAct !== null || singleActive !== null || !(visibleFacebook?.length || currentTikTok?.accounts.length)} className="focus-ring rounded-full border border-line px-4 py-2 text-[13px] text-cream disabled:opacity-40">{zh ? '保存为新看板' : 'Save as new board'}</button>
        <button
          type="button"
          onClick={ask}
          disabled={!hasFigures || tiktokBusy || facebookPending || refreshingAct !== null || singleActive !== null}
          className="focus-ring rounded-full bg-accent px-4 py-2 text-[13px] font-medium leading-5 text-[rgb(var(--bg-app))] disabled:opacity-40"
        >
          {zh ? '预览脱敏分析草稿' : 'Preview anonymized analysis'}
        </button>
        <p className="text-[12px] leading-[18px] text-cream-faint">
          {hasFigures ? (zh ? '先预览、编辑并复制，不覆盖已有对话草稿。' : 'Preview, edit and copy without replacing an existing chat draft.') : t('boards.today.askDisabled')}
        </p>
        <p className="text-[12px] leading-[18px] text-cream-faint">{t('boards.today.currencyNote')}</p>
      </div>
    </div>
  )
}

function rangeKey(range: TodayRange): I18nKey {
  if (range === 'today') return 'boards.today.range.today'
  if (range === 'last28') return 'boards.today.range.last28'
  return 'boards.today.range.last7'
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
        <li key={move.key ?? move.name} className="flex items-baseline justify-between gap-3 text-[12px] leading-[18px]">
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
  refreshDisabled,
  failure,
  syncError,
  progress,
  cancelling,
  onCancel,
  onRefresh,
  onAnalyze,
  onToggle,
  onStep,
  t
}: {
  account: TikTokTodayAccount
  generatedAt: number
  open: boolean
  busy: boolean
  refreshDisabled: boolean
  failure: TikTokFailure | null
  syncError: string | null
  progress: TTProgress | null
  cancelling: boolean
  onCancel: () => void
  onRefresh: () => void
  onAnalyze: () => void
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
      {!isTikTokTodayFailure(account) && account.window && <p className="text-[12px] leading-[18px] text-cream-faint">{formatReadingWindow(account.window)}{account.timezone ? ` · ${account.timezone}` : ''}{account.previousWindow ? ` · ${t('boards.today.compare').replace('{window}', formatReadingWindow(account.previousWindow))}` : ''}</p>}
    </div>
  )
  const refreshButton = <button type="button" onClick={onRefresh} disabled={refreshDisabled} className="focus-ring rounded-full border border-line px-2.5 py-1 text-[12px] text-cream-dim disabled:opacity-40">{busy ? t('boards.reading.refreshing') : t('boards.today.refreshThisTt')}</button>
  const progressNotice = busy ? <TTReadingProgress progress={progress} cancelling={cancelling} onCancel={onCancel} /> : null
  if (isTikTokTodayFailure(account)) {
    return (
      <article className="rounded-2xl border border-line bg-ink-850 px-4 py-3">
        {title}
        <div className="mt-2">{refreshButton}</div>
        {progressNotice}
        <ReadingErrorNotice
          className="mt-2"
          notice={tiktokReadingNotice(failure?.code ?? account.error, t, failure?.detail ?? account.detail)}
          detail={failure?.detail ?? account.detail}
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
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {refreshButton}
        <button type="button" onClick={onAnalyze} disabled={busy || !!failure || refreshDisabled} title={t('boards.today.singleDraftHint')} className="focus-ring rounded-full bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40">{t('boards.today.analyzeThisTt')}</button>
      </div>
      {progressNotice}
      {failure && <div role="status" className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">
        <p>{failure.detail === 'reading-window-expired' ? t('boards.today.singleWindowExpired') : failure.detail === 'single-result-invalid' ? t('boards.today.singleInvalidResult') : t('boards.today.singleFailedRetained')}</p>
        {failure.detail !== 'reading-window-expired' && failure.detail !== 'single-result-invalid' && <p>{tiktokReadingNotice(failure.code, t, failure.detail).message}</p>}
      </div>}
      {syncError && <p role="status" className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">{t(syncError === 'row-limit' ? 'boards.datasets.ttRowLimit' : syncError === 'proof-failed' ? 'boards.datasets.proofFailed' : 'boards.datasets.syncFailed')}</p>}
      <p className="mt-1 text-[11px] text-cream-faint">{t('boards.today.singleDraftHint')}</p>
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
  refreshDisabled,
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
  refreshDisabled?: boolean
  failure: string | null
  onToggle: () => void
  onRefresh: () => void
  onStep: (step: ReadingNextStep) => void
  t: Translate
}) {
  const delta = formatSpendDelta(row.spend, row.previousSpend)
  const lang = useAppStore(state => state.language)
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
            {row.spend === null ? '—' : `${formatTikTokAmount(row.spend)} ${row.currency ?? (lang === 'zh' ? '币种未知' : 'currency unknown')}`}
          </p>
          <p className="text-[12px] leading-[18px] tabular-nums text-cream-dim">
            {row.covered ? (delta ?? t('boards.today.noPrevious')) : '—'}
          </p>
        </div>
      </div>
      {row.readError && <p role="alert" className="mt-2 text-[12px] text-red-600">{lang === 'zh' ? '历史读数加载失败，账户仍已保留；请重试。' : 'History could not be loaded. The account is preserved; retry.'}</p>}
      {notice && failure && (
        <ReadingErrorNotice className="mt-2" notice={notice} detail={failure} onAction={onStep} busy={busy} />
      )}
      {row.covered && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy || refreshDisabled}
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
            label={`${lang === 'zh' ? '每次结果成本' : 'Cost per result'}${row.resultType ? ` · ${row.resultType}` : ''}`}
            value={row.costPerResult === null ? '—' : formatTikTokAmount(row.costPerResult)}
          />
        </div>
      )}
      {row.covered && row.spend !== null && <Movers movers={row.movers} t={t} />}
    </article>
  )
}
