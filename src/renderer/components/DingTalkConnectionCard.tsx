import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, LoaderCircle } from 'lucide-react'
import type { DingTalkConnectionError, DingTalkConnectionSnapshot } from '@shared/connections'
import { useT, type I18nKey } from '../i18n'
import BrandIcon from './BrandIcon'

const errorLabels: Record<DingTalkConnectionError, I18nKey> = {
  'cli-unavailable': 'connections.dingTalkCliUnavailable',
  'install-failed': 'connections.dingTalkInstallFailed',
  'authorization-failed': 'connections.dingTalkAuthorizationFailed',
  'organization-access-required': 'connections.dingTalkOrganizationAccess',
  network: 'connections.dingTalkNetworkError',
  'not-authorized': 'connections.dingTalkNotAuthorized',
  'connection-failed': 'connections.dingTalkActionFailed'
}

const secondaryButton = 'focus-ring min-h-9 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:bg-overlay hover:text-cream disabled:opacity-50'
const primaryButton = 'focus-ring min-h-9 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50'

type Action = 'connect' | 'cancel' | 'check' | 'disconnect'
type Operation = Action | 'status'

export default function DingTalkConnectionCard() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<DingTalkConnectionSnapshot | null>(null)
  const [operation, setOperation] = useState<Operation | null>('status')
  const [error, setError] = useState<I18nKey | null>(null)
  const currentOperation = useRef<Operation | null>('status')
  const requestId = useRef(0)
  const statusRevision = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    const initialRevision = statusRevision.current
    const unsubscribe = window.electronAPI.onDingTalkStatus(value => {
      if (!active) return
      statusRevision.current += 1
      setSnapshot(value)
    })
    void window.electronAPI.dingTalkStatus().then(value => {
      if (active && statusRevision.current === initialRevision) setSnapshot(value)
    }).catch(() => {
      if (active && statusRevision.current === initialRevision) setError('connections.dingTalkStatusUnavailable')
    }).finally(() => {
      if (active && currentOperation.current === 'status') {
        currentOperation.current = null
        setOperation(null)
      }
    })
    return () => {
      active = false
      mounted.current = false
      unsubscribe()
    }
  }, [])

  const run = async (action: Action) => {
    if (currentOperation.current && !(action === 'cancel' && currentOperation.current === 'connect')) return
    const id = ++requestId.current
    const revision = statusRevision.current
    currentOperation.current = action
    setOperation(action)
    setError(null)
    const isCurrent = () => mounted.current && id === requestId.current
    try {
      const api = window.electronAPI
      const calls = {
        connect: api.dingTalkConnect,
        cancel: api.dingTalkCancel,
        check: api.dingTalkReconnect,
        disconnect: api.dingTalkDisconnect
      }
      const result = await calls[action]()
      if (!isCurrent()) return
      if (statusRevision.current === revision) setSnapshot(result.snapshot)
      if (!result.ok) setError(errorLabels[result.error ?? result.snapshot.lastError ?? 'connection-failed'])
    } catch {
      if (isCurrent()) setError('connections.dingTalkActionFailed')
    } finally {
      if (isCurrent()) {
        currentOperation.current = null
        setOperation(null)
      }
    }
  }

  const openGuide = async () => {
    try {
      if (await window.electronAPI.dingTalkOpenGuide()) return
    } catch {
      // Report the browser launch failure without exposing IPC internals.
    }
    if (mounted.current) setError('connections.dingTalkOpenFailed')
  }

  const state = snapshot?.state
  const connected = state === 'connected'
  const pendingSignIn = state === 'installing' || state === 'authorizing' || operation === 'connect' || operation === 'cancel'
  const checking = state === 'checking' || operation === 'status' || operation === 'check'
  const pending = pendingSignIn || checking || operation === 'disconnect'
  const failed = state === 'error'
  const problem = error ?? (snapshot?.lastError ? errorLabels[snapshot.lastError] : null)
  const status = state === 'installing' ? 'connections.dingTalkInstalling'
    : state === 'authorizing' ? 'connections.dingTalkAuthorizing'
    : pending ? 'connections.checking'
    : connected ? 'connections.connected'
    : failed ? 'connections.error'
    : !snapshot ? 'connections.dingTalkStatusUnavailable'
    : 'connections.notConnected'

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5" aria-labelledby="dingtalk-connection-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-[245px]">
          <div className="flex min-h-10 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay">
              <BrandIcon brand="dingtalk" size={32} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="dingtalk-connection-heading" className="text-[15px] font-semibold text-cream">{t('connections.dingTalk')}</h2>
              <span role="status" className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${connected && !pending ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' : failed && !pending ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-overlay text-cream-dim'}`}>
                {pending && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
                {t(status)}
              </span>
            </div>
          </div>
          <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">
            {t(connected ? 'connections.dingTalkConnected' : state === 'authorizing' ? 'connections.dingTalkBrowserHint' : 'connections.dingTalkDescription')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pendingSignIn ? (
            <button type="button" disabled={operation === 'cancel'} onClick={() => void run('cancel')} className={secondaryButton}>
              {t('connections.dingTalkCancelSignIn')}
            </button>
          ) : connected || (checking && snapshot?.configured) ? (
            <button type="button" disabled={pending} onClick={() => void run('check')} className={secondaryButton}>
              {t('connections.dingTalkCheck')}
            </button>
          ) : (
            <button type="button" disabled={pending} onClick={() => void run('connect')} className={primaryButton}>
              {t('connections.dingTalkConnect')}
            </button>
          )}
          {snapshot?.configured && !pendingSignIn && (
            <button type="button" disabled={pending} onClick={() => void run('disconnect')} className={secondaryButton}>
              {t('connections.disconnect')}
            </button>
          )}
        </div>
      </div>

      {snapshot?.configured && (snapshot.accountName || snapshot.organizationName) && (
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12px] leading-5">
          {snapshot.accountName && <div className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="text-cream-faint">{t('connections.dingTalkAccount')}</dt>
            <dd className="break-all text-cream">{snapshot.accountName}</dd>
          </div>}
          {snapshot.organizationName && <div className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="text-cream-faint">{t('connections.dingTalkOrganization')}</dt>
            <dd className="break-all text-cream">{snapshot.organizationName}</dd>
          </div>}
        </dl>
      )}
      {problem && !pending && <p role="alert" className="mt-3 text-[12px] leading-5 text-red-600 dark:text-red-400">{t(problem)}</p>}
      <button type="button" onClick={() => void openGuide()} className="focus-ring mt-2.5 inline-flex min-h-8 items-center gap-1 rounded text-[12px] text-cream-dim hover:text-cream">
        {t('connections.dingTalkOpenGuide')} <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    </section>
  )
}
