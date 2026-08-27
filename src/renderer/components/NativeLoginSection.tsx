import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, LoaderCircle, LogIn, X } from 'lucide-react'
import type { CapabilityState, LoginAnswer, LoginState } from '@shared/types'
import { useT } from '../i18n'
import { useAppStore } from '../store'

type NativeLoginSectionProps = {
  providerId: string
  providerName?: string
  providerAvailable: boolean
  capability: CapabilityState
}

function isActive(state: LoginState): boolean {
  return (
    state.status === 'starting' ||
    state.status === 'waiting_for_browser' ||
    state.status === 'waiting_for_input' ||
    state.status === 'waiting_for_select' ||
    state.status === 'waiting_for_confirm' ||
    state.status === 'verifying'
  )
}

function providerIdOf(state: LoginState): string {
  return 'providerId' in state ? state.providerId : ''
}

/**
 * Current-runtime authentication surface. The native login protocol is
 * intentionally rendered here instead of being hidden behind a browser
 * action: the runtime can ask for an URL, a value, a choice, or a confirm
 * response while a single login flow is active.
 */
export default function NativeLoginSection({
  providerId,
  providerName,
  providerAvailable,
  capability
}: NativeLoginSectionProps) {
  const loginState = useAppStore((s) => s.loginState)
  const startLogin = useAppStore((s) => s.startLogin)
  const answerLogin = useAppStore((s) => s.answerLogin)
  const cancelLogin = useAppStore((s) => s.cancelLogin)
  const openLoginUrl = useAppStore((s) => s.openLoginUrl)
  const t = useT()

  const [input, setInput] = useState('')
  const [selectedOption, setSelectedOption] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const flowIsActive = isActive(loginState)
  const flowProviderId = providerIdOf(loginState)
  const terminalForSelectedProvider =
    !flowIsActive &&
    flowProviderId === providerId &&
    (loginState.status === 'connected' || loginState.status === 'failed' || loginState.status === 'cancelled')
  const visibleState = flowIsActive || terminalForSelectedProvider ? loginState : null
  const isOtherProviderFlow = flowIsActive && Boolean(providerId) && flowProviderId !== providerId

  const promptKey = useMemo(() => {
    if ('requestId' in loginState) return `${loginState.status}:${loginState.requestId}`
    return `${loginState.status}:${flowProviderId}`
  }, [flowProviderId, loginState])

  // A new runtime prompt must never retain a value entered for the previous
  // prompt. Select prompts get a deterministic first choice, while an empty
  // option list remains explicitly non-submittable.
  useEffect(() => {
    setInput('')
    setActionError(null)
    if (loginState.status === 'waiting_for_select') {
      setSelectedOption(loginState.options[0] ?? '')
    } else {
      setSelectedOption('')
    }
  }, [promptKey, loginState])

  const run = async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busy) return false
    setBusy(true)
    setActionError(null)
    try {
      const result = await operation()
      if (!result.ok) {
        setActionError(result.error ?? 'failed')
        return false
      }
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const connect = () => {
    if (!providerId || !providerAvailable || capability === 'unsupported') return
    void run(() => startLogin(providerId))
  }

  const answer = (value: LoginAnswer) => {
    void run(() => answerLogin(value))
  }

  const cancel = () => {
    void run(cancelLogin)
  }

  const openBrowser = (url: string) => {
    void run(() => openLoginUrl(url))
  }

  const buttonCls =
    'flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'
  const primaryButtonCls =
    'flex items-center gap-1.5 rounded-full border border-line bg-ink-800 px-3 py-1.5 text-[12px] text-cream transition-colors hover:border-ink-600 disabled:opacity-40'
  const inputCls =
    'h-8 min-w-52 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none placeholder:text-cream-faint focus:border-ink-600 disabled:opacity-40'

  const selectedLabel = providerName || providerId
  const activeLabel = flowProviderId || selectedLabel
  const browserUrl =
    loginState.status === 'waiting_for_browser' ? loginState.launchUrl || loginState.url || '' : ''

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-[13px] text-cream">{t('settings.nativeLogin')}</span>
          {capability === 'unknown' && !flowIsActive && (
            <p className="mt-1 text-[11px] leading-relaxed text-cream-faint">
              {t('settings.nativeLoginUnknown')}
            </p>
          )}
          {capability === 'unsupported' && (
            <p className="mt-1 text-[11px] leading-relaxed text-cream-faint">
              {t('settings.nativeLoginUnsupported')}
            </p>
          )}
        </div>

        {!flowIsActive && capability !== 'unsupported' && (
          <button
            type="button"
            onClick={connect}
            disabled={busy || !providerId || !providerAvailable}
            className={primaryButtonCls}
          >
            <LogIn size={12} />
            {t('settings.nativeLoginConnect')}
          </button>
        )}
      </div>

      {!providerId && !flowIsActive && capability !== 'unsupported' && (
        <p className="mt-2 text-[11px] text-cream-faint">{t('settings.nativeLoginSelectProvider')}</p>
      )}
      {providerId && !providerAvailable && !flowIsActive && capability !== 'unsupported' && (
        <p className="mt-2 text-[11px] text-amber-500">{t('settings.nativeLoginUnavailable')}</p>
      )}
      {isOtherProviderFlow && (
        <p className="mt-2 text-[11px] text-cream-faint">
          {t('settings.nativeLoginOtherProviderActive', { provider: activeLabel })}
        </p>
      )}

      {visibleState?.status === 'starting' && (
        <StatusRow icon={<LoaderCircle size={13} className="animate-spin" />}>
          {t('settings.nativeLoginStarting', { provider: activeLabel })}
        </StatusRow>
      )}

      {visibleState?.status === 'waiting_for_browser' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5">
          <ExternalLink size={13} className="shrink-0 text-cream-faint" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-cream">{t('settings.nativeLoginBrowser')}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-cream-faint">
              {visibleState.instructions || t('settings.nativeLoginBrowserInstructions')}
            </p>
            {browserUrl && (
              <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-cream-faint" title={browserUrl}>
                {browserUrl}
              </p>
            )}
          </div>
          {browserUrl && (
            <button
              type="button"
              onClick={() => openBrowser(browserUrl)}
              disabled={busy}
              className={primaryButtonCls}
            >
              <ExternalLink size={12} />
              {t('settings.nativeLoginOpenBrowser')}
            </button>
          )}
        </div>
      )}

      {visibleState?.status === 'waiting_for_input' && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (input.trim()) answer({ value: input.trim() })
          }}
        >
          <label className="min-w-52 flex-1">
            <span className="mb-1 block text-xs text-cream">{visibleState.title || t('settings.nativeLoginInput')}</span>
            <input
              type="password"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={visibleState.placeholder || t('settings.nativeLoginInputPlaceholder')}
              disabled={busy}
              autoComplete="off"
              className={`${inputCls} w-full`}
            />
          </label>
          <button type="submit" disabled={busy || !input.trim()} className={primaryButtonCls}>
            {busy ? <LoaderCircle size={12} className="animate-spin" /> : <LogIn size={12} />}
            {t('settings.nativeLoginSubmit')}
          </button>
        </form>
      )}

      {visibleState?.status === 'waiting_for_select' && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (selectedOption) answer({ value: selectedOption })
          }}
        >
          <label className="min-w-52 flex-1">
            <span className="mb-1 block text-xs text-cream">{visibleState.title || t('settings.nativeLoginSelect')}</span>
            <select
              value={selectedOption}
              onChange={(event) => setSelectedOption(event.target.value)}
              disabled={busy || visibleState.options.length === 0}
              className={`${inputCls} w-full`}
            >
              {visibleState.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || !selectedOption}
            className={primaryButtonCls}
          >
            {busy ? <LoaderCircle size={12} className="animate-spin" /> : <LogIn size={12} />}
            {t('settings.nativeLoginSubmit')}
          </button>
          {visibleState.options.length === 0 && (
            <p className="w-full text-[11px] text-amber-500">{t('settings.nativeLoginNoOptions')}</p>
          )}
        </form>
      )}

      {visibleState?.status === 'waiting_for_confirm' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-800/50 px-3 py-2.5">
          <AlertCircle size={13} className="shrink-0 text-cream-faint" />
          <div className="min-w-40 flex-1">
            <p className="text-xs text-cream">{visibleState.title || t('settings.nativeLoginConfirm')}</p>
            {visibleState.message && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-cream-faint">{visibleState.message}</p>
            )}
          </div>
          <button type="button" onClick={() => answer({ confirmed: false })} disabled={busy} className={buttonCls}>
            {t('settings.nativeLoginConfirmNo')}
          </button>
          <button type="button" onClick={() => answer({ confirmed: true })} disabled={busy} className={primaryButtonCls}>
            {busy && <LoaderCircle size={12} className="animate-spin" />}
            {t('settings.nativeLoginConfirmYes')}
          </button>
        </div>
      )}

      {visibleState?.status === 'verifying' && (
        <StatusRow icon={<LoaderCircle size={13} className="animate-spin" />}>
          {visibleState.message || t('settings.nativeLoginVerifying')}
        </StatusRow>
      )}

      {visibleState?.status === 'connected' && (
        <StatusRow icon={<CheckCircle2 size={13} className="text-emerald-500" />} tone="success">
          {t('settings.nativeLoginConnected', { provider: activeLabel })}
        </StatusRow>
      )}

      {visibleState?.status === 'cancelled' && (
        <StatusRow icon={<X size={13} />}>
          {t('settings.nativeLoginCancelled')}
        </StatusRow>
      )}

      {visibleState?.status === 'failed' && (
        <StatusRow icon={<AlertCircle size={13} />} tone="error">
          {t('settings.nativeLoginFailed', { error: visibleState.message })}
        </StatusRow>
      )}

      {flowIsActive && (
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={cancel} disabled={busy} className={buttonCls}>
            {busy ? <LoaderCircle size={12} className="animate-spin" /> : <X size={12} />}
            {t('settings.nativeLoginCancel')}
          </button>
        </div>
      )}

      {actionError && (
        <p className="mt-2 text-[11px] text-red-500">
          {t('settings.nativeLoginActionFailed', { error: actionError })}
        </p>
      )}
    </div>
  )
}

function StatusRow({
  icon,
  tone = 'neutral',
  children
}: {
  icon: React.ReactNode
  tone?: 'neutral' | 'success' | 'error'
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'error' ? 'text-red-500' : 'text-cream-dim'
  return <p className={`mt-2 flex items-center gap-1.5 text-xs ${toneClass}`}>{icon}{children}</p>
}
