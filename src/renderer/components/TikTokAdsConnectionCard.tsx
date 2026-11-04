import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import { TikTokAdsConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'
import BrandIcon from './BrandIcon'

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
 * Which advertisers the readings use. TikTok's report API needs an
 * advertiser id per call and the authorization does not always say which
 * ones it covers, so the user can list them here (ids only, stored by Main).
 */
function ReadingAdvertisers() {
  const t = useT()
  const [saved, setSaved] = useState<string[] | null>(null)
  const [granted, setGranted] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'invalid-input' | 'write-failed'>('idle')

  useEffect(() => {
    let active = true
    void window.electronAPI
      .ttReadingAdvertisers()
      .then((value) => {
        if (!active) return
        setSaved(value.selected)
        setGranted(value.granted)
        setDraft(value.selected.join(', '))
      })
      .catch(() => {
        if (active) setSaved([])
      })
    return () => {
      active = false
    }
  }, [])

  const save = async () => {
    setState('saving')
    try {
      const result = await window.electronAPI.ttReadingSetAdvertisers({ advertiserIds: draft })
      if (result.ok) {
        setSaved(result.selected)
        setDraft(result.selected.join(', '))
        setState('saved')
      } else {
        setState(result.error)
      }
    } catch {
      setState('write-failed')
    }
  }

  const dirty = saved !== null && draft.trim() !== saved.join(', ')
  const empty = saved !== null && saved.length === 0 && draft.trim() === ''
  const shownGranted = granted.slice(0, 3).join(', ') + (granted.length > 3 ? '…' : '')
  const hint =
    state === 'invalid-input'
      ? { text: t('boards.tt.invalidAdvertisers'), tone: 'error' as const }
      : state === 'write-failed'
        ? { text: t('connections.tiktokAdvertisersFailed'), tone: 'error' as const }
        : state === 'saved'
          ? { text: t('connections.tiktokAdvertisersSaved'), tone: 'plain' as const }
          : empty && granted.length > 0
            ? { text: t('connections.tiktokAdvertisersGranted', { n: granted.length, ids: shownGranted }), tone: 'plain' as const }
            : empty
              ? { text: t('connections.tiktokAdvertisersNone'), tone: 'warning' as const }
              : { text: t('connections.tiktokAdvertisersHint'), tone: 'plain' as const }

  return (
    <div className="mt-3 rounded-xl bg-overlay px-3 py-3">
      <label htmlFor="tiktok-reading-advertisers" className="text-[12px] leading-[18px] text-cream-faint">
        {t('connections.tiktokAdvertisers')}
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="tiktok-reading-advertisers"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setState('idle')
          }}
          disabled={saved === null}
          inputMode="numeric"
          spellCheck={false}
          placeholder="7300000000000000000, 7311111111111111111"
          className="min-w-0 flex-1 rounded-lg border border-line bg-ink-850 px-2 py-1 font-mono text-[12px] leading-[18px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || state === 'saving'}
          className="min-h-8 focus-ring shrink-0 rounded-lg border border-line px-3 py-1 text-[12px] leading-[18px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-40"
        >
          {t('connections.tiktokAdvertisersSave')}
        </button>
      </div>
      <p
        role={hint.tone === 'error' ? 'alert' : undefined}
        className={`mt-1.5 break-words text-[12px] leading-[18px] ${
          hint.tone === 'error'
            ? 'text-red-600 dark:text-red-400'
            : hint.tone === 'warning'
              ? 'text-[#866021] dark:text-[#DAC393]'
              : 'text-cream-faint'
        }`}
      >
        {hint.text}
      </p>
    </div>
  )
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
  const isFailed = snapshot.status === 'failed'
  const isDegraded = snapshot.status === 'degraded' || snapshot.status === 'needs_attention'
  const isConnected = snapshot.connected
  const tokenExpiry = snapshot.tokenExpiresAt
    ? new Date(snapshot.tokenExpiresAt).toLocaleString()
    : null
  const tokenExpired = typeof snapshot.tokenExpiresAt === 'number' && snapshot.tokenExpiresAt <= Date.now()
  const lastConnected = snapshot.lastConnectedAt
    ? new Date(snapshot.lastConnectedAt).toLocaleString()
    : null

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5" aria-labelledby="tiktok-connection-heading" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex min-h-10 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay text-cream">
            <BrandIcon brand="tiktok" size={32} />
          </span>
            <h2 id="tiktok-connection-heading" className="text-[15px] font-semibold text-cream">{t('connections.tiktok')}</h2>
          </div>
            <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">
              {t('connections.tiktokDescription')}
            </p>
        </div>
        {!isConnected && !isWaiting && !isConnecting && !isFailed && !isDegraded && (
          <button
            onClick={() => void begin()}
            disabled={busy}
            className="min-h-8 focus-ring flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-[rgb(var(--bg-app))] transition hover:bg-accent-bright disabled:opacity-50"
          >
            {t('connections.tiktokConnect')}
          </button>
        )}
      </div>

      {isConnecting && (
        <div role="status" className="mt-4 flex items-center gap-2 text-[12px] text-cream-dim">
          <LoaderCircle size={14} className="animate-spin text-accent" />
          {t('connections.tiktokDiscovering')}
        </div>
      )}

      {isWaiting && (
        <div className="mt-4">
          <div role="status" className="flex items-center gap-2 text-[13px] font-medium text-amber-700 dark:text-amber-300">
            <LoaderCircle size={14} className="animate-spin" />
            {t('connections.tiktokWaiting')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => snapshot.authorizationUrl && void window.electronAPI.tiktokOpenUrl(snapshot.authorizationUrl)}
              className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"
            >
              <ArrowUpRight size={12} /> {t('connections.tiktokOpenLink')}
            </button>
            <button
              onClick={() => void cancel()}
              disabled={busy}
              className="min-h-8 focus-ring rounded-lg px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream disabled:opacity-50"
            >
              {t('connections.cancel')}
            </button>
          </div>
        </div>
      )}

      {isConnected && (
        <div className="mt-4">
          {!isFailed && !isDegraded && !isWaiting && !isConnecting && <div role="status" className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 size={16} /> {t('connections.tiktokConnected')}
          </div>}
          {tokenExpired && <p className="mb-3 text-[12px] text-amber-700 dark:text-amber-300">{t('connections.tiktokTokenExpired')}</p>}
          <ReadingAdvertisers />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void begin()}
              disabled={busy}
              className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] leading-[18px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.tiktokReauthorize')}
            </button>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] leading-[18px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
            >
              <Unplug size={12} /> {t('connections.disconnect')}
            </button>
          </div>
          <details className="mt-4 border-t border-line pt-3">
            <summary className="focus-ring w-fit cursor-pointer rounded text-[12px] leading-5 text-cream-dim hover:text-cream">
              {t('connections.tiktokDetails')}
            </summary>
            <dl className="mt-3 grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2">
              <div><dt className="text-cream-faint">{t('connections.tiktokServer')}</dt><dd className="mt-1 text-cream-dim">{t('connections.tiktokOfficial')}</dd></div>
              <div><dt className="text-cream-faint">{t('connections.tiktokTokenExpires')}</dt><dd className={`mt-1 break-words tabular-nums ${tokenExpired ? 'text-amber-800 dark:text-amber-200' : 'text-cream-dim'}`}>{tokenExpired ? t('connections.tiktokTokenExpired') : tokenExpiry ?? '—'}</dd></div>
              {lastConnected && <div><dt className="text-cream-faint">{t('connections.tiktokLastConnected')}</dt><dd className="mt-1 break-words tabular-nums text-cream-dim">{lastConnected}</dd></div>}
            </dl>
            <p className="mt-3 text-[12px] leading-5 text-cream-faint">{t('connections.tiktokNote')}</p>
          </details>
        </div>
      )}

      {(isFailed || isDegraded) && (
        <div className="mt-4">
          <div role="alert" className="flex items-center gap-2 text-[13px] font-medium text-red-600 dark:text-red-400">
            <AlertTriangle size={15} /> {t('connections.tiktokFailed')}
          </div>
          {snapshot.lastError && (
            <p className="mt-1 break-words text-[12px] leading-[18px] text-cream-dim">{snapshot.lastError}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void begin()}
              disabled={busy}
              className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.retry')}
            </button>
            <button
              onClick={() => void cancel()}
              disabled={busy}
              className="min-h-8 focus-ring rounded-lg px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream disabled:opacity-50"
            >
              {t('connections.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
