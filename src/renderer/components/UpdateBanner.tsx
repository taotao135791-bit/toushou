import { useEffect, useState } from 'react'
import { AlertCircle, Download, LoaderCircle, RotateCw, X } from 'lucide-react'
import { UpdaterStatus } from '@shared/types'
import { useT } from '../i18n'

/**
 * Global update banner. The packaged app already checks for updates 10s
 * after launch (src/main/updater.ts); this surface turns that signal into a
 * one-click flow: available → download (progress inline) → restart & install.
 * Dev builds never show it (status stays idle/dev). Mid-download states are
 * deliberately not dismissible; `available` and `error` are.
 */
export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdaterStatus>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const t = useT()

  useEffect(() => {
    window.electronAPI.updaterGetStatus().then(setStatus)
    return window.electronAPI.onUpdaterStatus(setStatus)
  }, [])

  // A new version (or a retry after error) re-opens a dismissed banner.
  useEffect(() => {
    setDismissed(false)
  }, [status])

  if (dismissed) return null

  const pillCls =
    'flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream'
  const actionCls =
    'flex items-center gap-1.5 rounded-full border border-line bg-ink-800 px-3 py-1.5 text-[12px] text-cream transition-colors hover:border-ink-600'

  let content: React.ReactNode = null
  let dismissible = false

  if (status.status === 'available') {
    dismissible = true
    content = (
      <>
        <span className="text-[12px] text-cream-dim">{t('update.available', { version: status.version })}</span>
        <button
          type="button"
          className={actionCls}
          onClick={() => {
            void window.electronAPI.updaterDownload()
          }}
        >
          <Download size={12} />
          {t('update.action')}
        </button>
      </>
    )
  } else if (status.status === 'downloading' || status.status === 'progress') {
    const percent = status.status === 'progress' ? Math.round(status.percent) : null
    content = (
      <>
        <LoaderCircle size={12} className="animate-spin text-cream-faint" />
        <span className="text-[12px] text-cream-dim">
          {percent === null
            ? t('update.downloading')
            : t('update.downloadingPercent', { percent: String(percent) })}
        </span>
      </>
    )
  } else if (status.status === 'downloaded') {
    content = (
      <>
        <span className="text-[12px] text-cream-dim">{t('update.ready', { version: status.version })}</span>
        <button
          type="button"
          className={actionCls}
          onClick={() => window.electronAPI.updaterQuitAndInstall()}
        >
          <RotateCw size={12} />
          {t('update.install')}
        </button>
      </>
    )
  } else if (status.status === 'error') {
    dismissible = true
    content = (
      <>
        <AlertCircle size={12} className="shrink-0 text-amber-500" />
        <span className="text-[12px] text-cream-dim">{t('update.failed')}</span>
        <button
          type="button"
          className={pillCls}
          onClick={() => {
            void window.electronAPI.updaterOpenReleasePage()
          }}
        >
          {t('update.fallback')}
        </button>
      </>
    )
  }

  if (!content) return null

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-line bg-ink-900/80 px-3 py-1.5">
      {content}
      {dismissible && (
        <button
          type="button"
          aria-label={t('update.dismiss')}
          className="ml-1 rounded p-0.5 text-cream-faint transition-colors hover:text-cream"
          onClick={() => setDismissed(true)}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
