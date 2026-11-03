import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import type { AppsFlyerConnectionSnapshot } from '@shared/connections'
import appsflyerLogo from '../assets/appsflyer-logo.svg'
import { useT } from '../i18n'

/** The logo is the unmodified SVG used on AppsFlyer's official security page:
 * https://www.appsflyer.com/wp-content/uploads/2021/02/AppsFlyer-logo.svg */
export default function AppsFlyerConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<AppsFlyerConnectionSnapshot | null>(null)
  const [busy, setBusy] = useState<'status' | 'begin' | 'cancel' | 'disconnect' | 'open' | null>('status')
  const [error, setError] = useState(false)
  const sequence = useRef(0)
  const eventVersion = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    let receivedEvent = false
    const unsubscribe = window.electronAPI.onAppsFlyerStatus((value) => {
      receivedEvent = true
      eventVersion.current += 1
      if (active) setSnapshot(value)
    })
    void window.electronAPI.appsflyerStatus().then((value) => {
      if (active && !receivedEvent && sequence.current === 0) setSnapshot(value)
    }).catch(() => {
      if (active && !receivedEvent && sequence.current === 0) setError(true)
    }).finally(() => {
      if (active && sequence.current === 0) setBusy(null)
    })
    return () => { active = false; mounted.current = false; unsubscribe() }
  }, [])

  const run = async (action: 'status' | 'begin' | 'cancel' | 'disconnect') => {
    const current = ++sequence.current
    const eventsAtStart = eventVersion.current
    setBusy(action)
    setError(false)
    try {
      const api = window.electronAPI
      const value = await (action === 'status' ? api.appsflyerStatus() : action === 'begin' ? api.appsflyerBegin() : action === 'cancel' ? api.appsflyerCancel() : api.appsflyerDisconnect())
      if (mounted.current && current === sequence.current && eventsAtStart === eventVersion.current) setSnapshot(value)
    } catch {
      if (mounted.current && current === sequence.current) setError(true)
    } finally {
      if (mounted.current && current === sequence.current) setBusy(null)
    }
  }

  const open = async () => {
    if (!snapshot?.authorizationUrl) return
    const current = ++sequence.current
    setBusy('open')
    setError(false)
    try {
      if (!await window.electronAPI.appsflyerOpenUrl(snapshot.authorizationUrl)) {
        if (mounted.current && current === sequence.current) setError(true)
      }
    } catch {
      if (mounted.current && current === sequence.current) setError(true)
    } finally {
      if (mounted.current && current === sequence.current) setBusy(null)
    }
  }

  const status = snapshot?.status
  const waiting = status === 'waiting_for_user'
  const connecting = status === 'connecting'
  const failed = status === 'failed' || status === 'degraded' || status === 'needs_attention'
  const ready = snapshot?.connected && !waiting && !connecting && !failed
  const canCancel = (waiting || connecting) && (busy === null || busy === 'begin')
  const tokenExpired = typeof snapshot?.tokenExpiresAt === 'number' && snapshot.tokenExpiresAt <= Date.now()
  const date = (value?: number) => value && Number.isFinite(value) ? new Date(value).toLocaleString() : '—'

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5 shadow-card" aria-labelledby="appsflyer-heading" aria-busy={busy !== null}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex rounded-lg bg-white px-2 py-1">
            <img src={appsflyerLogo} alt="" className="h-7 w-auto" />
          </div>
          <h2 id="appsflyer-heading" className="mt-2 text-[15px] font-semibold text-cream">AppsFlyer</h2>
          <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">{t('connections.appsflyerDescription')}</p>
        </div>
        {snapshot && !snapshot.connected && !waiting && !connecting && !failed && (
          <button type="button" onClick={() => void run('begin')} disabled={busy !== null} className="focus-ring shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50">{t('connections.appsflyerConnect')}</button>
        )}
      </div>

      {!snapshot && !error && <div role="status" className="mt-4 flex items-center gap-2 text-[12px] text-cream-faint"><LoaderCircle size={14} className="animate-spin" />{t('connections.appsflyerLoading')}</div>}
      {(waiting || connecting) && <div className="mt-4">
        <div role="status" className="flex items-center gap-2 text-[13px] text-cream-dim"><LoaderCircle size={14} className="animate-spin" />{t(waiting ? 'connections.appsflyerWaiting' : 'connections.appsflyerConnecting')}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {waiting && snapshot?.authorizationUrl && <button type="button" onClick={() => void open()} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"><ArrowUpRight size={12} />{t('connections.appsflyerOpen')}</button>}
          <button type="button" onClick={() => void run('cancel')} disabled={!canCancel} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50">{t('connections.cancel')}</button>
        </div>
      </div>}
      {ready && <div className="mt-4">
        <div role="status" className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={16} />{t('connections.appsflyerConnected')}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {typeof snapshot.appCount === 'number' && <div className="flex justify-between gap-3 rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{t('connections.appsflyerApps')}</span><span className="text-cream-dim">{snapshot.appCount}</span></div>}
          <div className="flex justify-between gap-3 rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{t('connections.tiktokTokenExpires')}</span><span className="text-right text-cream-dim">{tokenExpired ? t('connections.tiktokTokenExpired') : date(snapshot.tokenExpiresAt)}</span></div>
          {snapshot.lastConnectedAt && <div className="flex justify-between gap-3 rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{t('connections.tiktokLastConnected')}</span><span className="text-right text-cream-dim">{date(snapshot.lastConnectedAt)}</span></div>}
        </div>
      </div>}
      {failed && <div role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-300"><AlertTriangle size={15} />{t('connections.appsflyerNeedsAttention')}</div>}
      {snapshot?.lastError && <p className="mt-2 break-words text-[12px] leading-5 text-cream-faint">{snapshot.lastError}</p>}
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-400">{t('connections.appsflyerActionFailed')}</p>}
      {(failed || ready || (error && !waiting && !connecting)) && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void run(snapshot ? 'begin' : 'status')} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50"><RefreshCw size={12} />{t(snapshot ? ready ? 'connections.tiktokReauthorize' : 'connections.retry' : 'connections.retry')}</button>
        {(snapshot?.connected || failed) && <button type="button" onClick={() => void run('disconnect')} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-red-500/20 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"><Unplug size={12} />{t('connections.disconnect')}</button>}
      </div>}
    </section>
  )
}
