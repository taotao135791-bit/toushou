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
    <section className="rounded-2xl border border-line bg-ink-850 p-5" aria-labelledby="appsflyer-heading" aria-busy={busy !== null}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex min-h-10 items-center gap-3">
            <div className="flex h-10 shrink-0 items-center rounded-lg bg-white px-1.5">
              <img src={appsflyerLogo} alt="" className="h-8 w-auto" />
            </div>
            <h2 id="appsflyer-heading" className="sr-only">AppsFlyer</h2>
          </div>
          <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">{t('connections.appsflyerDescription')}</p>
        </div>
        {snapshot && !snapshot.connected && !waiting && !connecting && !failed && (
          <button type="button" onClick={() => void run('begin')} disabled={busy !== null} className="min-h-8 focus-ring shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50">{t('connections.appsflyerConnect')}</button>
        )}
      </div>

      {!snapshot && !error && <div role="status" className="mt-4 flex items-center gap-2 text-[12px] text-cream-faint"><LoaderCircle size={14} className="animate-spin" />{t('connections.appsflyerLoading')}</div>}
      {(waiting || connecting) && <div className="mt-4">
        <div role="status" className="flex items-center gap-2 text-[13px] text-cream-dim"><LoaderCircle size={14} className="animate-spin" />{t(waiting ? 'connections.appsflyerWaiting' : 'connections.appsflyerConnecting')}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {waiting && snapshot?.authorizationUrl && <button type="button" onClick={() => void open()} disabled={busy !== null} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"><ArrowUpRight size={12} />{t('connections.appsflyerOpen')}</button>}
          <button type="button" onClick={() => void run('cancel')} disabled={!canCancel} className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50">{t('connections.cancel')}</button>
        </div>
      </div>}
      {ready && <div className="mt-4">
        <div role="status" className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={16} />{t('connections.appsflyerConnected')}</div>
        {typeof snapshot.appCount === 'number' && <p className="text-[12px] text-cream-dim">{t('connections.appsflyerApps')} <span className="ml-1 font-medium tabular-nums text-cream">{snapshot.appCount}</span></p>}
        {tokenExpired && <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">{t('connections.tiktokTokenExpired')}</p>}
      </div>}
      {failed && <div role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-300"><AlertTriangle size={15} />{t('connections.appsflyerNeedsAttention')}</div>}
      {snapshot?.lastError && <p className="mt-2 break-words text-[12px] leading-5 text-cream-faint">{snapshot.lastError}</p>}
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-400">{t('connections.appsflyerActionFailed')}</p>}
      {(failed || ready || (error && !waiting && !connecting)) && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void run(snapshot ? 'begin' : 'status')} disabled={busy !== null} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50"><RefreshCw size={12} />{t(snapshot ? ready ? 'connections.tiktokReauthorize' : 'connections.retry' : 'connections.retry')}</button>
        {(snapshot?.connected || failed) && <button type="button" onClick={() => void run('disconnect')} disabled={busy !== null} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"><Unplug size={12} />{t('connections.disconnect')}</button>}
      </div>}
      {ready && <details className="mt-4 border-t border-line pt-3">
        <summary className="focus-ring w-fit cursor-pointer rounded text-[12px] leading-5 text-cream-dim hover:text-cream">{t('connections.tiktokDetails')}</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2">
          <div><dt className="text-cream-faint">{t('connections.tiktokTokenExpires')}</dt><dd className="mt-1 break-words tabular-nums text-cream-dim">{tokenExpired ? t('connections.tiktokTokenExpired') : date(snapshot.tokenExpiresAt)}</dd></div>
          {snapshot.lastConnectedAt && <div><dt className="text-cream-faint">{t('connections.tiktokLastConnected')}</dt><dd className="mt-1 break-words tabular-nums text-cream-dim">{date(snapshot.lastConnectedAt)}</dd></div>}
        </dl>
      </details>}
    </section>
  )
}
