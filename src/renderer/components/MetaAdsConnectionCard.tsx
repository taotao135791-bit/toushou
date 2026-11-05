import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Infinity, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import type { MetaAdsConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'

export default function MetaAdsConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<MetaAdsConnectionSnapshot | null>(null)
  const [busy, setBusy] = useState<'status' | 'begin' | 'cancel' | 'disconnect' | 'open' | null>('status')
  const [error, setError] = useState<'status' | 'action' | 'bridge' | null>(null)
  const sequence = useRef(0)
  const eventVersion = useRef(0)
  const mounted = useRef(false)

  const failure = (cause: unknown, fallback: 'status' | 'action') =>
    cause instanceof Error && /No handler registered|is not a function/.test(cause.message) ? 'bridge' as const : fallback

  useEffect(() => {
    mounted.current = true
    let active = true
    let receivedEvent = false
    let unsubscribe = () => {}
    try {
      unsubscribe = window.electronAPI.onMetaAdsStatus((value) => {
        receivedEvent = true
        eventVersion.current += 1
        if (active) { setSnapshot(value); setError(null) }
      })
      void window.electronAPI.metaAdsStatus().then((value) => {
        if (active && !receivedEvent && sequence.current === 0) setSnapshot(value)
      }).catch((cause: unknown) => {
        if (active && !receivedEvent && sequence.current === 0) setError(failure(cause, 'status'))
      }).finally(() => {
        if (active && sequence.current === 0) setBusy(null)
      })
    } catch (cause) { setError(failure(cause, 'status')); setBusy(null) }
    return () => { active = false; mounted.current = false; unsubscribe() }
  }, [])

  const run = async (action: 'status' | 'begin' | 'cancel' | 'disconnect') => {
    const current = ++sequence.current
    const eventsAtStart = eventVersion.current
    setBusy(action)
    setError(null)
    try {
      const api = window.electronAPI
      const value = await (action === 'status' ? api.metaAdsStatus() : action === 'begin' ? api.metaAdsBegin() : action === 'cancel' ? api.metaAdsCancel() : api.metaAdsDisconnect())
      if (mounted.current && current === sequence.current && eventsAtStart === eventVersion.current) setSnapshot(value)
    } catch (cause) {
      if (mounted.current && current === sequence.current) setError(failure(cause, 'action'))
    } finally {
      if (mounted.current && current === sequence.current) setBusy(null)
    }
  }

  const open = async () => {
    if (!snapshot?.authorizationUrl) return
    const current = ++sequence.current
    setBusy('open')
    setError(null)
    try {
      if (!await window.electronAPI.metaAdsOpenUrl(snapshot.authorizationUrl)) {
        if (mounted.current && current === sequence.current) setError('action')
      }
    } catch (cause) {
      if (mounted.current && current === sequence.current) setError(failure(cause, 'action'))
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
    <section className="rounded-2xl border border-line bg-ink-850 p-5 shadow-card" aria-labelledby="meta-ads-heading" aria-busy={busy !== null}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-overlay text-cream" aria-hidden="true">
              <Infinity size={22} />
            </div>
            <div>
              <h2 id="meta-ads-heading" className="text-[15px] font-semibold text-cream">Meta Ads</h2>
              <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">{t('connections.metaAdsDescription')}</p>
            </div>
          </div>
        </div>
        {!snapshot?.connected && !waiting && !connecting && (
          <button type="button" onClick={() => void run('begin')} disabled={busy !== null} className="focus-ring shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50">{t('connections.metaAdsConnect')}</button>
        )}
      </div>

      {!snapshot && !error && <div role="status" className="mt-4 flex items-center gap-2 text-[12px] text-cream-faint"><LoaderCircle size={14} className="animate-spin" />{t('connections.metaAdsLoading')}</div>}
      {(waiting || connecting) && <div className="mt-4">
        <div role="status" className="flex items-center gap-2 text-[13px] text-cream-dim"><LoaderCircle size={14} className="animate-spin" />{t(waiting ? 'connections.metaAdsWaiting' : 'connections.metaAdsConnecting')}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {waiting && snapshot?.authorizationUrl && <button type="button" onClick={() => void open()} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"><ArrowUpRight size={12} />{t('connections.metaAdsOpen')}</button>}
          <button type="button" onClick={() => void run('cancel')} disabled={!canCancel} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50">{t('connections.cancel')}</button>
        </div>
      </div>}
      {ready && <div className="mt-4">
        <div role="status" className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={16} />{t('connections.metaAdsConnected')}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex justify-between gap-3 rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{t('connections.tiktokTokenExpires')}</span><span className="text-right text-cream-dim">{tokenExpired ? t('connections.tiktokTokenExpired') : date(snapshot.tokenExpiresAt)}</span></div>
          {snapshot.lastConnectedAt && <div className="flex justify-between gap-3 rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{t('connections.tiktokLastConnected')}</span><span className="text-right text-cream-dim">{date(snapshot.lastConnectedAt)}</span></div>}
        </div>
      </div>}
      {failed && <div role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-300"><AlertTriangle size={15} />{t('connections.metaAdsNeedsAttention')}</div>}
      {snapshot?.lastError && <p className="mt-2 break-words text-[12px] leading-5 text-cream-faint">{snapshot.lastError}</p>}
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-400">{t(error === 'bridge' ? 'connections.metaAdsRestartRequired' : error === 'status' ? 'connections.metaAdsStatusFailed' : 'connections.metaAdsActionFailed')}</p>}
      {(failed || ready || (error && !waiting && !connecting)) && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void run(snapshot ? 'begin' : 'status')} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50"><RefreshCw size={12} />{t(snapshot ? ready ? 'connections.tiktokReauthorize' : 'connections.retry' : 'connections.retry')}</button>
        {(snapshot?.connected || failed) && <button type="button" onClick={() => void run('disconnect')} disabled={busy !== null} className="focus-ring flex items-center gap-1.5 rounded-full border border-red-500/20 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"><Unplug size={12} />{t('connections.disconnect')}</button>}
      </div>}
    </section>
  )
}
