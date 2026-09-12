import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import { TikTokAdsConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'

const emptySnapshot: TikTokAdsConnectionSnapshot = {
  definition: {
    id: 'tiktok-ads',
    kind: 'oauth',
    label: 'TikTok Ads',
    description: '',
    capabilities: ['mcp']
  },
  status: 'disconnected',
  connected: false
}

/**
 * TikTok Ads official MCP connector card. The whole OAuth exchange lives in
 * Main (discovery → dynamic client registration → PKCE loopback → browser
 * authorize → token): this card only renders secret-free snapshots and
 * forwards connect/cancel/disconnect intents.
 */
export default function TikTokAdsConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<TikTokAdsConnectionSnapshot>(emptySnapshot)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void window.electronAPI.tiktokStatus().then((value) => {
      if (active) setSnapshot(value)
    })
    const unsubscribe = window.electronAPI.onTiktokStatus((value) => {
      if (active) setSnapshot(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const begin = async () => {
    setBusy(true)
    setSnapshot(await window.electronAPI.tiktokBegin())
    setBusy(false)
  }

  const cancel = async () => {
    setBusy(true)
    setSnapshot(await window.electronAPI.tiktokCancel())
    setBusy(false)
  }

  const disconnect = async () => {
    setBusy(true)
    setSnapshot(await window.electronAPI.tiktokDisconnect())
    setBusy(false)
  }

  const isWaiting = snapshot.status === 'waiting_for_user'
  const isConnecting = snapshot.status === 'connecting'
  const isConnected = snapshot.connected
  const isFailed = snapshot.status === 'failed'
  const isDegraded = snapshot.status === 'degraded'
  const tokenExpiry = snapshot.tokenExpiresAt
    ? new Date(snapshot.tokenExpiresAt).toLocaleString()
    : null

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-overlay text-cream">
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 1 1-1.84-2.48V9.77a5.68 5.68 0 1 0 4.93 5.63V8.87a7.35 7.35 0 0 0 4.3 1.38V7.16a4.28 4.28 0 0 1-3.24-1.34Z"
              />
            </svg>
          </span>
          <div>
            <h2 className="text-[15px] font-semibold text-cream">{t('connections.tiktok')}</h2>
            <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">
              {t('connections.tiktokDescription')}
            </p>
          </div>
        </div>
        {!isConnected && !isWaiting && !isConnecting && (
          <button
            onClick={() => void begin()}
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white transition hover:bg-accent-bright disabled:opacity-50"
          >
            {t('connections.tiktokConnect')}
          </button>
        )}
      </div>

      {isConnecting && (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-cream-faint">
          <LoaderCircle size={14} className="animate-spin text-accent" />
          {t('connections.tiktokDiscovering')}
        </div>
      )}

      {isWaiting && (
        <div className="mt-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-amber-600 dark:text-amber-300">
            <LoaderCircle size={14} className="animate-spin" />
            {t('connections.tiktokWaiting')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => snapshot.authorizationUrl && void window.electronAPI.tiktokOpenUrl(snapshot.authorizationUrl)}
              className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"
            >
              <ArrowUpRight size={12} /> {t('connections.tiktokOpenLink')}
            </button>
            <button
              onClick={() => void cancel()}
              disabled={busy}
              className="rounded-full px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream disabled:opacity-50"
            >
              {t('connections.cancel')}
            </button>
          </div>
        </div>
      )}

      {isConnected && (
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={16} /> {t('connections.tiktokConnected')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
              <span className="text-cream-faint">{t('connections.tiktokServer')}</span>
              <span className="font-mono text-cream-dim">tiktok-ads</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
              <span className="text-cream-faint">{t('connections.tiktokTokenExpires')}</span>
              <span className="text-cream-dim">{tokenExpiry ?? '—'}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => void begin()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.tiktokReauthorize')}
            </button>
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-red-500/20 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Unplug size={12} /> {t('connections.disconnect')}
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-cream-faint">{t('connections.tiktokNote')}</p>
        </div>
      )}

      {(isFailed || isDegraded) && (
        <div className="mt-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-red-500">
            <AlertTriangle size={15} /> {t('connections.tiktokFailed')}
          </div>
          {snapshot.lastError && (
            <p className="mt-1 break-all text-[12px] leading-5 text-cream-faint">{snapshot.lastError}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void begin()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-bright disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.retry')}
            </button>
            <button
              onClick={() => void cancel()}
              disabled={busy}
              className="rounded-full px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream disabled:opacity-50"
            >
              {t('connections.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
