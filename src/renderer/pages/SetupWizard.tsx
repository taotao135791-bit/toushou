import { useEffect, useState } from 'react'
import { Download, CheckCircle, AlertCircle, Loader2, Terminal, ArrowRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import Logo from '../components/Logo'

export default function SetupWizard() {
  const {
    cliAvailable,
    installStatus,
    setCliAvailable,
    setSetupComplete,
    setInstallStatus
  } = useAppStore(
    useShallow((s) => ({
      cliAvailable: s.cliAvailable,
      installStatus: s.installStatus,
      setCliAvailable: s.setCliAvailable,
      setSetupComplete: s.setSetupComplete,
      setInstallStatus: s.setInstallStatus
    }))
  )
  const t = useT()

  // The real command is copied verbatim but never displayed, keeping the
  // first-run surface brand-neutral (runtime details live in Settings).
  const manualCommand = 'curl -fsSL https://omp.sh/install | sh'
  const [copied, setCopied] = useState(false)
  const [manualFailed, setManualFailed] = useState(false)

  useEffect(() => {
    window.electronAPI.detectCli().then((info) => {
      setCliAvailable(info.available)
      if (info.available) {
        setSetupComplete(true)
      }
    })
  }, [setCliAvailable, setSetupComplete])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onInstallStatus((status) => {
      setInstallStatus(status)
      if (status.type === 'success') {
        window.electronAPI.detectCli().then((info) => {
          setCliAvailable(info.available)
          if (info.available) {
            setSetupComplete(true)
          }
        })
      }
    })
    return () => unsubscribe()
  }, [setInstallStatus, setCliAvailable, setSetupComplete])

  const handleAutoInstall = async () => {
    setInstallStatus({ type: 'downloading', progress: 0, message: 'Starting download...' })
    await window.electronAPI.installOmp()
    // error status is delivered by installer events
  }

  const handleManualDone = async () => {
    const info = await window.electronAPI.detectCli()
    setCliAvailable(info.available)
    if (info.available) {
      setManualFailed(false)
      setSetupComplete(true)
    } else {
      // The CLI still isn't on PATH — say so, or the button looks dead.
      setManualFailed(true)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(manualCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (cliAvailable === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-ink-950">
        <Loader2 className="mb-4 animate-spin text-accent" size={30} />
        <div className="text-sm text-cream-dim">{t('setup.detecting')}</div>
      </div>
    )
  }

  if (cliAvailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-ink-950">
        <CheckCircle className="mb-4 text-accent" size={44} />
        <div className="text-xl font-semibold tracking-tight text-cream">{t('setup.ready.title')}</div>
        <div className="mt-2 text-sm text-cream-dim">{t('setup.ready.subtitle')}</div>
      </div>
    )
  }

  const isInstalling = installStatus.type !== 'idle' && installStatus.type !== 'error' && installStatus.type !== 'success'
  const isError = installStatus.type === 'error'

  return (
    <div className="flex h-full flex-col items-center justify-center bg-ink-950 p-8">
      <div className="w-full max-w-xl rounded-2xl border border-line bg-ink-900 p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} className="shrink-0" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-cream">{t('setup.welcome.title')}</h1>
            <p className="text-sm text-cream-dim">{t('setup.welcome.subtitle')}</p>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-yellow-500/20 bg-yellow-500/[0.08] p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 shrink-0 text-yellow-400" size={18} />
            <div className="text-sm leading-6 text-yellow-200/90">{t('setup.missing')}</div>
          </div>
        </div>

        <div className="space-y-4">
          <button
            onClick={handleAutoInstall}
            disabled={isInstalling}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-cream px-4 py-3 text-sm font-medium text-ink-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isInstalling ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Download size={18} />
            )}
            {isInstalling ? t('setup.installing') : t('setup.autoInstall')}
          </button>

          {installStatus.type === 'downloading' && (
            <div className="space-y-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-overlay-strong">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${installStatus.progress}%` }}
                />
              </div>
              <div className="font-mono text-xs text-cream-dim">{installStatus.message}</div>
            </div>
          )}

          {(installStatus.type === 'installing' || installStatus.type === 'success') && (
            <div className="rounded-xl bg-ink-800 p-3 text-xs text-cream-dim">
              <div className="mb-1 flex items-center gap-1.5 text-cream-faint">
                <Terminal size={12} />
                {t('setup.installLog')}
              </div>
              <div className="font-mono">
                {installStatus.type === 'installing'
                  ? installStatus.message
                  : t('setup.installComplete')}
              </div>
            </div>
          )}

          {isError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] p-3 text-xs text-red-200">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertCircle size={12} />
                {t('setup.installFailed')}
              </div>
              <pre className="whitespace-pre-wrap font-mono">{installStatus.message}</pre>
            </div>
          )}

          <div className="relative flex items-center py-2">
            <div className="flex-1 border-t border-line" />
            <span className="px-3 text-xs text-cream-faint">{t('setup.orManual')}</span>
            <div className="flex-1 border-t border-line" />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-cream-faint">{t('setup.terminalCommand')}</label>
            <div className="flex gap-2">
              <input
                readOnly
                value={t('setup.terminalCommandMasked')}
                className="flex-1 rounded-lg border border-line bg-ink-950 px-3 py-2 font-mono text-xs text-cream-dim outline-none"
              />
              <button
                onClick={handleCopy}
                className="shrink-0 whitespace-nowrap rounded-lg border border-line px-3 py-2 text-xs text-cream-dim transition hover:bg-overlay-strong hover:text-cream"
              >
                {copied ? t('setup.copied') : t('setup.copy')}
              </button>
            </div>
            <button
              onClick={handleManualDone}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-4 py-2 text-sm text-cream-dim transition hover:bg-overlay-strong hover:text-cream"
            >
              {t('setup.installed')}
              <ArrowRight size={14} />
            </button>
            {manualFailed && (
              <div className="flex items-start gap-1.5 text-xs leading-5 text-red-500">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                {t('setup.stillMissing')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
