import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, LoaderCircle, PenTool, RefreshCw, Unplug } from 'lucide-react'
import { FigmaConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'

const emptySnapshot: FigmaConnectionSnapshot = {
  definition: {
    id: 'figma',
    kind: 'channel',
    label: 'Figma',
    description: '',
    capabilities: ['mcp']
  },
  status: 'disconnected',
  connected: false
}

/**
 * Figma Dev Mode MCP connector card — deliberately the LOCAL flavor:
 * use_figma executes Plugin-API JavaScript on the user's machine and all
 * reasoning happens in the coding model, so it spends only code tokens and
 * no Figma-side generation credits. Enabling is a Figma-desktop preference;
 * the card probes the loopback endpoint and installs the bundled skills.
 */
export default function FigmaConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<FigmaConnectionSnapshot>(emptySnapshot)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void window.electronAPI.figmaStatus().then((value) => {
      if (active) setSnapshot(value)
    })
    const unsubscribe = window.electronAPI.onFigmaStatus((value) => {
      if (active) setSnapshot(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const connect = async () => {
    setBusy(true)
    setSnapshot(await window.electronAPI.figmaConnect())
    setBusy(false)
  }

  const disconnect = async () => {
    setBusy(true)
    setSnapshot(await window.electronAPI.figmaDisconnect())
    setBusy(false)
  }

  const isConnected = snapshot.connected
  const isDegraded = snapshot.status === 'degraded'
  const isFailed = snapshot.status === 'failed'
  const isConnecting = snapshot.status === 'connecting'

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-overlay text-cream">
            <PenTool size={15} />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold text-cream">{t('connections.figma')}</h2>
            <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">
              {t('connections.figmaDescription')}
            </p>
          </div>
        </div>
        {!isConnected && !isConnecting && (
          <button
            onClick={() => void connect()}
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white transition hover:bg-accent-bright disabled:opacity-50"
          >
            {t('connections.figmaConnect')}
          </button>
        )}
      </div>

      {isConnecting && (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-cream-faint">
          <LoaderCircle size={14} className="animate-spin text-accent" />
          {t('connections.figmaProbing')}
        </div>
      )}

      {isConnected && (
        <div className="mt-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={16} /> {t('connections.figmaConnected')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
              <span className="text-cream-faint">{t('connections.figmaServer')}</span>
              <span className="font-mono text-cream-dim">figma</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
              <span className="text-cream-faint">{t('connections.figmaTools')}</span>
              <span className="text-cream-dim">{snapshot.toolCount ?? '—'}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.figmaRecheck')}
            </button>
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border border-red-500/20 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Unplug size={12} /> {t('connections.disconnect')}
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-cream-faint">{t('connections.figmaSkillsNote')}</p>
        </div>
      )}

      {(isDegraded || isFailed) && (
        <div className="mt-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-amber-600 dark:text-amber-300">
            <AlertTriangle size={15} /> {t('connections.figmaNotServing')}
          </div>
          {snapshot.lastError && (
            <p className="mt-1 break-all text-[12px] leading-5 text-cream-faint">{snapshot.lastError}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-bright disabled:opacity-50"
            >
              <RefreshCw size={12} /> {t('connections.retry')}
            </button>
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="rounded-full px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream disabled:opacity-50"
            >
              {t('connections.disconnect')}
            </button>
          </div>
        </div>
      )}

      {!isConnected && !isConnecting && !isDegraded && !isFailed && (
        <p className="mt-4 text-[11px] leading-4 text-cream-faint">{t('connections.figmaEnableHint')}</p>
      )}
    </section>
  )
}
