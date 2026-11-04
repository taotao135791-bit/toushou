import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import { FigmaConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'
import BrandIcon from './BrandIcon'

const emptySnapshot: FigmaConnectionSnapshot = {
  definition: { id: 'figma', kind: 'channel', label: 'Figma', description: '', capabilities: ['mcp'] },
  status: 'disconnected',
  connected: false
}

/** Local Dev Mode MCP only; the card forwards existing intents, never adds permissions. */
export default function FigmaConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<FigmaConnectionSnapshot>(emptySnapshot)
  const [busy, setBusy] = useState<'status' | 'connect' | 'disconnect' | null>('status')
  const [actionError, setActionError] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const eventVersion = useRef(0)
  const inFlight = useRef(true)

  useEffect(() => {
    mounted.current = true
    let active = true
    let receivedEvent = false
    const unsubscribe = window.electronAPI.onFigmaStatus((value) => {
      receivedEvent = true
      eventVersion.current += 1
      if (active) setSnapshot(value)
    })
    void window.electronAPI.figmaStatus().then((value) => {
      if (active && !receivedEvent && sequence.current === 0) setSnapshot(value)
    }).catch(() => {
      if (active && !receivedEvent && sequence.current === 0) setActionError(true)
    }).finally(() => {
      if (active && sequence.current === 0) { inFlight.current = false; setBusy(null) }
    })
    return () => { active = false; mounted.current = false; unsubscribe() }
  }, [])

  const run = async (action: 'connect' | 'disconnect') => {
    if (inFlight.current) return
    inFlight.current = true
    const current = ++sequence.current
    const eventsAtStart = eventVersion.current
    setBusy(action)
    setActionError(false)
    try {
      const value = await (action === 'connect' ? window.electronAPI.figmaConnect() : window.electronAPI.figmaDisconnect())
      if (mounted.current && current === sequence.current && eventsAtStart === eventVersion.current) setSnapshot(value)
    } catch {
      if (mounted.current && current === sequence.current) setActionError(true)
    } finally {
      if (mounted.current && current === sequence.current) { inFlight.current = false; setBusy(null) }
    }
  }

  const isConnected = snapshot.connected
  const needsAttention = snapshot.status === 'degraded' || snapshot.status === 'needs_attention' || snapshot.status === 'failed'
  const isConnecting = snapshot.status === 'connecting'
  const ready = isConnected && !needsAttention && !isConnecting

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5" aria-labelledby="figma-connection-heading" aria-busy={busy !== null}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex min-h-10 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay"><BrandIcon brand="figma" size={24} /></span>
            <h2 id="figma-connection-heading" className="text-[15px] font-semibold text-cream">{t('connections.figma')}</h2>
          </div>
          <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">{t('connections.figmaDescription')}</p>
        </div>
        {!isConnected && !isConnecting && !needsAttention && !actionError && (
          <button type="button" onClick={() => void run('connect')} disabled={busy !== null}
            className="focus-ring flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] transition-colors hover:bg-accent-bright disabled:opacity-50">
            {busy !== null && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
            {t('connections.figmaConnect')}
          </button>
        )}
      </div>

      {isConnecting && <div role="status" className="mt-4 flex items-center gap-2 text-[12px] text-cream-dim"><LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" />{t('connections.figmaProbing')}</div>}

      {isConnected && <div className="mt-4">
        {ready && <div role="status" className="flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={16} className="shrink-0" aria-hidden="true" />{t('connections.figmaConnected')}</div>}
        <p className="mt-2 text-[12px] text-cream-dim">{t('connections.figmaTools')} <span className="ml-1 font-medium tabular-nums text-cream">{snapshot.toolCount ?? '—'}</span></p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void run('connect')} disabled={busy !== null}
            className="focus-ring flex min-h-8 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50"><RefreshCw size={12} aria-hidden="true" />{t('connections.figmaRecheck')}</button>
          <button type="button" onClick={() => void run('disconnect')} disabled={busy !== null}
            className="focus-ring flex min-h-8 items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"><Unplug size={12} aria-hidden="true" />{t('connections.disconnect')}</button>
        </div>
        <details className="mt-4 border-t border-line pt-3">
          <summary className="focus-ring w-fit cursor-pointer rounded text-[12px] leading-5 text-cream-dim hover:text-cream">{t('connections.tiktokDetails')}</summary>
          <dl className="mt-3 text-[12px]"><dt className="text-cream-faint">{t('connections.figmaServer')}</dt><dd className="mt-1 text-cream-dim">Figma Dev Mode MCP</dd></dl>
          <p className="mt-3 text-[12px] leading-5 text-cream-faint">{t('connections.figmaSkillsNote')}</p>
        </details>
      </div>}

      {needsAttention && <div role="alert" className="mt-4">
        <div className="flex items-center gap-2 text-[13px] font-medium text-amber-700 dark:text-amber-300"><AlertTriangle size={15} className="shrink-0" aria-hidden="true" />{t('connections.figmaNotServing')}</div>
        {snapshot.lastError && <p className="mt-1 break-words text-[12px] leading-5 text-cream-dim">{snapshot.lastError}</p>}
      </div>}
      {actionError && <p role="alert" className="mt-3 text-[12px] leading-5 text-red-600 dark:text-red-400">{t('connections.appsflyerActionFailed')}</p>}
      {(needsAttention || actionError) && !isConnected && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void run('connect')} disabled={busy !== null}
          className="focus-ring flex min-h-8 items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50"><RefreshCw size={12} aria-hidden="true" />{t('connections.retry')}</button>
        <button type="button" onClick={() => void run('disconnect')} disabled={busy !== null}
          className="focus-ring min-h-8 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50">{t('connections.disconnect')}</button>
      </div>}
      {!isConnected && !isConnecting && !needsAttention && <p className="mt-4 text-[12px] leading-5 text-cream-faint">{t('connections.figmaEnableHint')}</p>}
    </section>
  )
}
