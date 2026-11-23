import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowUpRight, Copy, LoaderCircle, LockKeyhole, RefreshCw, Unplug } from 'lucide-react'
import type { DingTalkConnectionError, DingTalkConnectionSnapshot } from '@shared/connections'
import { useT } from '../i18n'
import type { I18nKey } from '../i18n'
import BrandIcon from './BrandIcon'

const errorLabels: Record<DingTalkConnectionError, I18nKey> = {
  'invalid-credentials': 'connections.dingTalkInvalidCredentials',
  'storage-unavailable': 'connections.dingTalkStorageUnavailable',
  network: 'connections.dingTalkNetworkError',
  configuration: 'connections.dingTalkConfigurationError',
  'connection-failed': 'connections.dingTalkActionFailed'
}

const secondaryButton = 'focus-ring flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50'
const primaryButton = 'focus-ring min-h-9 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50'
const credentialInput = 'focus-ring mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[13px] text-cream'

export default function DingTalkConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<DingTalkConnectionSnapshot | null>(null)
  const [editing, setEditing] = useState(false)
  const [operation, setOperation] = useState<'check' | 'connect' | 'reconnect' | 'retry-storage' | 'disconnect' | null>('check')
  const [error, setError] = useState<I18nKey | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<{ command: string; copied: boolean } | null>(null)
  const statusRevision = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    const initialRevision = statusRevision.current
    const unsubscribe = window.electronAPI.onDingTalkStatus((value) => {
      if (!active) return
      statusRevision.current += 1
      setSnapshot(value)
    })
    void window.electronAPI.dingTalkStatus().then((value) => {
      if (active && statusRevision.current === initialRevision) setSnapshot(value)
    }).catch(() => {
      // The missing snapshot exposes the status retry until a fresh value arrives.
    }).finally(() => {
      if (active) setOperation(null)
    })
    return () => {
      active = false
      mounted.current = false
      unsubscribe()
    }
  }, [])

  const run = async (action: NonNullable<typeof operation>) => {
    const revision = statusRevision.current
    setOperation(action)
    setError(null)
    try {
      const api = window.electronAPI
      if (action === 'check') {
        const value = await api.dingTalkStatus()
        if (mounted.current && statusRevision.current === revision) setSnapshot(value)
        return
      }
      const result = await (action === 'connect'
        ? api.dingTalkConnect({ clientId: clientId.trim(), clientSecret: clientSecret.trim() })
        : action === 'disconnect' ? api.dingTalkDisconnect() : api.dingTalkReconnect())
      if (!mounted.current) return
      if (statusRevision.current === revision) setSnapshot(result.snapshot)
      if (!result.ok) {
        if (!result.error) setError('connections.dingTalkActionFailed')
        else if (result.error !== result.snapshot.lastError) setError(errorLabels[result.error])
        if (action === 'connect' && result.error === 'invalid-credentials') setClientSecret('')
      } else if (action === 'connect' || action === 'disconnect') {
        setEditing(false)
        setClientId('')
        setClientSecret('')
      }
    } catch {
      if (mounted.current) setError('connections.dingTalkActionFailed')
    } finally {
      if (mounted.current) setOperation(null)
    }
  }

  const openSetupLink = async (destination: 'console' | 'guide') => {
    setError(null)
    try {
      const api = window.electronAPI
      const opened = await (destination === 'console' ? api.dingTalkOpenSetup() : api.dingTalkOpenGuide())
      if (opened) return
    } catch {
      // Keep the credential form open when the browser could not be launched.
    }
    if (mounted.current) setError('connections.dingTalkOpenFailed')
  }

  const state = snapshot?.state
  const busy = operation !== null
  const connecting = state === 'connecting' || state === 'reconnecting' || operation === 'connect' || operation === 'reconnect'
  const connected = state === 'connected' && !connecting
  const paired = connected && snapshot?.paired
  const unavailable = !snapshot && !busy
  const failed = state === 'error' && !connecting
  const pairingStorageBlocked = connected && !paired && snapshot?.lastError === 'storage-unavailable'
  const problem = error || (snapshot?.lastError ? errorLabels[snapshot.lastError] : null)
  const command = connected && !paired && snapshot?.pairingCode ? `/pair ${snapshot.pairingCode}` : null
  const feedback = copyFeedback?.command === command ? copyFeedback : null
  let statusLabel: I18nKey = 'connections.checking'
  if (state === 'reconnecting' || operation === 'reconnect') statusLabel = 'connections.dingTalkReconnecting'
  else if (connecting) statusLabel = 'connections.dingTalkConnecting'
  else if (connected) statusLabel = paired ? 'connections.connected' : 'connections.dingTalkPendingPair'
  else if (failed) statusLabel = 'connections.error'
  else if (unavailable) statusLabel = 'connections.dingTalkStatusUnavailable'
  else if (snapshot) statusLabel = 'connections.notConnected'

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && !connecting && clientId.trim() && clientSecret.trim()) void run('connect')
  }

  const copyCommand = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      if (mounted.current) setCopyFeedback({ command, copied: true })
    } catch {
      if (mounted.current) setCopyFeedback({ command, copied: false })
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5" aria-labelledby="dingtalk-connection-heading" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-[260px]">
          <div className="flex min-h-10 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay"><BrandIcon brand="dingtalk" size={32} /></div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="dingtalk-connection-heading" className="text-[15px] font-semibold text-cream">{t('connections.dingTalk')}</h2>
              <span role="status" className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${paired ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' : failed || connected ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-overlay text-cream-dim'}`}>
                {(connecting || operation === 'check') && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
                {t(statusLabel)}
              </span>
            </div>
          </div>
          <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">{t('connections.dingTalkDescription')}</p>
        </div>
        {snapshot && !snapshot.configured && !editing && !connecting && (
          <button type="button" aria-expanded={editing} aria-controls="dingtalk-credential-form" disabled={busy} onClick={() => { setError(null); setEditing(true) }} className={primaryButton}>
            {t('connections.dingTalkConnect')}
          </button>
        )}
      </div>

      {command && <div className="mt-4 rounded-xl bg-overlay px-3 py-3">
        <p className="text-[12px] leading-5 text-cream-dim">{t('connections.dingTalkPairHint')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="select-text break-all rounded-lg border border-line bg-ink-850 px-2.5 py-2 text-[13px] text-cream">{command}</code>
          <button type="button" onClick={() => void copyCommand()} className={secondaryButton}><Copy size={12} aria-hidden="true" />{t(feedback?.copied ? 'connections.dingTalkCopied' : 'connections.dingTalkCopyPairing')}</button>
        </div>
        {feedback && !feedback.copied && <p role="status" className="mt-2 text-[12px] text-cream-dim">{t('connections.dingTalkCopyFailed')}</p>}
      </div>}
      {paired && <p className="mt-3 text-[12px] leading-5 text-cream-dim">{t('connections.dingTalkPairedHint')}</p>}

      {snapshot?.configured && !editing && (
        <div className="mt-4 flex flex-wrap gap-2">
          {(failed || state === 'reconnecting' || pairingStorageBlocked) && <button type="button" disabled={busy} onClick={() => void run(pairingStorageBlocked ? 'retry-storage' : 'reconnect')} className={secondaryButton}><RefreshCw size={12} aria-hidden="true" />{t(operation === 'retry-storage' ? 'connections.checking' : pairingStorageBlocked ? 'connections.dingTalkRetryStorage' : 'connections.dingTalkReconnect')}</button>}
          <button type="button" aria-expanded={editing} aria-controls="dingtalk-credential-form" disabled={busy || connecting} onClick={() => { setError(null); setEditing(true) }} className={secondaryButton}>{t('connections.dingTalkUpdateCredentials')}</button>
          <button type="button" disabled={busy} onClick={() => void run('disconnect')} className="focus-ring flex min-h-9 items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"><Unplug size={12} aria-hidden="true" />{t('connections.disconnect')}</button>
        </div>
      )}
      {unavailable && <button type="button" onClick={() => void run('check')} className={`${secondaryButton} mt-4`}><RefreshCw size={12} aria-hidden="true" />{t('connections.retry')}</button>}

      {editing && <form id="dingtalk-credential-form" onSubmit={submit} className="mt-4 border-t border-line pt-4" autoComplete="off">
        <ol className="ml-5 list-decimal space-y-1 text-[12px] leading-5 text-cream-dim">
          <li>{t('connections.dingTalkSetupApp')}</li>
          <li>{t('connections.dingTalkSetupStream')}</li>
          <li>{t('connections.dingTalkSetupCredentials')}</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void openSetupLink('console')} className={secondaryButton}><ArrowUpRight size={12} aria-hidden="true" />{t('connections.dingTalkOpenConsole')}</button>
          <button type="button" onClick={() => void openSetupLink('guide')} className={secondaryButton}><ArrowUpRight size={12} aria-hidden="true" />{t('connections.dingTalkOpenGuide')}</button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-[12px] text-cream-dim">Client ID (AppKey)
            <input type="text" autoComplete="off" spellCheck={false} maxLength={512} disabled={busy || connecting} value={clientId} onChange={(event) => setClientId(event.target.value)} className={credentialInput} required />
          </label>
          <label className="block text-[12px] text-cream-dim">Client Secret (AppSecret)
            <input type="password" autoComplete="new-password" maxLength={512} disabled={busy || connecting} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} className={credentialInput} required />
          </label>
        </div>
        <p className="mt-3 flex items-center gap-2 text-[12px] text-cream-dim"><LockKeyhole size={13} className="shrink-0" aria-hidden="true" />{t('connections.secureNote')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={busy || connecting || !clientId.trim() || !clientSecret.trim()} className={primaryButton}>{t(operation === 'connect' ? 'connections.dingTalkConnecting' : 'connections.dingTalkVerifyConnect')}</button>
          <button type="button" disabled={busy} onClick={() => { setEditing(false); setClientId(''); setClientSecret(''); setError(null) }} className={secondaryButton}>{t('connections.cancel')}</button>
        </div>
      </form>}
      {problem && !connecting && <p role="alert" className="mt-3 text-[12px] leading-5 text-red-600 dark:text-red-400">{t(problem)}</p>}
    </section>
  )
}
