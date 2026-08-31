import { useEffect } from 'react'
import { BookOpen, X } from 'lucide-react'
import { PackageManagerProfile } from '@shared/types'
import { useT, I18nKey } from '../i18n'

/**
 * Read-only, in-app summary of the plugin interface spec
 * (docs/plugin-interface-spec.md): accepted install sources for the detected
 * runtime profile, a minimal manifest, and the capability/trust limits.
 */

const MANIFEST_EXAMPLE = `{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What the plugin does",
  "omp": { "extensions": ["extensions/index.ts"] },
  "pi": { "extensions": ["extensions/index.ts"] },
  "files": ["extensions"]
}`

export function PluginGuideDialog({
  profile,
  onClose
}: {
  profile: PackageManagerProfile
  onClose: () => void
}) {
  const t = useT()
  const legacy = profile === 'legacy'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const sourceKeys: I18nKey[] = legacy
    ? ['plugins.guide.sources.legacy.github', 'plugins.guide.sources.legacy.npm', 'plugins.guide.sources.legacy.local']
    : ['plugins.guide.sources.omp.github', 'plugins.guide.sources.omp.npm', 'plugins.guide.sources.omp.local']

  const limitKeys: I18nKey[] = [
    'plugins.guide.limits.api',
    'plugins.guide.limits.bridge',
    'plugins.guide.limits.noDeps',
    'plugins.guide.limits.session',
    'plugins.guide.limits.trust'
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('plugins.guide.title')}
        className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-[620px] flex-col overflow-hidden rounded-[20px] border border-line bg-ink-850 shadow-pop"
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-5 py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <BookOpen size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-cream">{t('plugins.guide.title')}</h2>
            <p className="mt-0.5 text-[11px] leading-4 text-cream-faint">{t('plugins.guide.hint')}</p>
          </div>
          <button
            onClick={onClose}
            title={t('plugins.guide.close')}
            className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
            {t('plugins.guide.sourcesTitle')}
          </div>
          <ul className="mt-2 space-y-1.5">
            {sourceKeys.map((key) => (
              <li key={key} className="flex items-start gap-2 text-[12px] leading-5 text-cream-dim">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
            {t('plugins.guide.manifestTitle')}
          </div>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[11px] leading-5 text-cream-dim">
            {MANIFEST_EXAMPLE}
          </pre>
          <p className="mt-2 text-[11px] leading-4 text-cream-faint">{t('plugins.guide.manifestNote')}</p>

          <div className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
            {t('plugins.guide.limitsTitle')}
          </div>
          <ul className="mt-2 space-y-1.5">
            {limitKeys.map((key) => (
              <li key={key} className="flex items-start gap-2 text-[12px] leading-5 text-cream-dim">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] leading-4 text-cream-faint">{t('plugins.guide.more')}</p>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-full border border-line px-3.5 py-2 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
          >
            {t('plugins.guide.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}
