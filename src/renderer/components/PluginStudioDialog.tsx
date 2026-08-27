import { useEffect, useState } from 'react'
import { Check, Code2, Loader2, Save, X } from 'lucide-react'
import { ManagedPluginDetail } from '@shared/types'
import { useT } from '../i18n'

const starterCode = `/**
 * OMP GUI managed plugin.
 *
 * The default export is loaded by OMP/Pi as an extension factory. Add commands,
 * tools, event handlers, or UI requests here.
 */
export default function (pi: unknown) {
  void pi
}
`

const inputClass =
  'w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-cream outline-none transition placeholder:text-cream-faint focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10.5px] font-medium uppercase tracking-wider text-cream-faint">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-4 text-cream-faint">{hint}</span>}
    </label>
  )
}

export function PluginStudioDialog({
  plugin,
  onClose,
  onChanged
}: {
  plugin?: ManagedPluginDetail | null
  onClose: () => void
  onChanged: () => Promise<void> | void
}) {
  const t = useT()
  const [name, setName] = useState(plugin?.name ?? '')
  const [displayName, setDisplayName] = useState(plugin?.displayName ?? '')
  const [description, setDescription] = useState(plugin?.description ?? '')
  const [version, setVersion] = useState(plugin?.version ?? '0.1.0')
  const [code, setCode] = useState(plugin?.code ?? starterCode)
  // A new source becomes an existing managed plugin immediately after its
  // first save. Keep its opaque id locally so a second save updates the same
  // source instead of creating a duplicate while the dialog stays open.
  const [pluginId, setPluginId] = useState(plugin?.id)
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [synced, setSynced] = useState(Boolean(plugin?.syncedAt))
  const lockedName = Boolean(plugin?.syncedAt || synced)
  const editing = Boolean(pluginId)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const save = async (alsoSync: boolean) => {
    if (busy) return
    setError(null)
    setBusy(alsoSync ? 'sync' : 'save')
    try {
      const saved = await window.electronAPI.saveManagedPlugin({
        ...(pluginId ? { id: pluginId } : {}),
        name,
        displayName,
        description,
        version,
        code
      })
      if (!saved.ok) {
        setError(saved.error)
        return
      }
      setPluginId(saved.plugin.id)
      await onChanged()
      if (!alsoSync) return
      const result = await window.electronAPI.syncManagedPlugin(saved.plugin.id)
      if (!result.ok) {
        setError(result.error || result.log || 'Could not sync the plugin.')
        return
      }
      setSynced(true)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={editing ? t('plugins.write.dialogEdit') : t('plugins.write.dialogNew')}
        className="flex max-h-[min(820px,calc(100vh-2rem))] w-full max-w-[860px] flex-col overflow-hidden rounded-[20px] border border-line bg-ink-850 shadow-pop"
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-5 py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Code2 size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-cream">
              {editing ? t('plugins.write.dialogEdit') : t('plugins.write.dialogNew')}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-cream-faint">{t('plugins.write.dialogHint')}</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy !== null}
            title={t('plugins.write.close')}
            className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay hover:text-cream disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('plugins.write.name')}>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={lockedName || busy !== null}
                placeholder="omp-my-plugin"
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label={t('plugins.write.displayName')}>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={busy !== null}
                className={inputClass}
              />
            </Field>
            <Field label={t('plugins.write.description')}>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy !== null}
                className={inputClass}
              />
            </Field>
            <Field label={t('plugins.write.version')}>
              <input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                disabled={busy !== null}
                className={`${inputClass} font-mono`}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label={t('plugins.write.code')} hint={t('plugins.write.codeHint')}>
              <textarea
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy !== null}
                spellCheck={false}
                rows={17}
                className={`${inputClass} min-h-[280px] resize-y font-mono text-[12px] leading-5`}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
              {error}
            </p>
          )}
          {synced && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-500">
              <Check size={13} />
              {t('plugins.write.reloadHint')}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <button
            onClick={onClose}
            disabled={busy !== null}
            className="rounded-full border border-line px-3.5 py-2 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
          >
            {t('plugins.write.close')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void save(false)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream disabled:opacity-50"
            >
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {busy === 'save' ? t('plugins.write.saving') : t('plugins.write.save')}
            </button>
            <button
              onClick={() => void save(true)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-full bg-cream px-4 py-2 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'sync' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {busy === 'sync' ? t('plugins.write.syncing') : t('plugins.write.saveSync')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
