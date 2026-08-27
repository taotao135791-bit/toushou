import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  FolderOpen,
  Hammer,
  MessageSquareText,
  Palette,
  Plus,
  Sparkles,
  Wrench
} from 'lucide-react'
import { DirectoryGrant, PluginScaffoldError, PluginScaffoldOutput, PluginTemplate } from '@shared/types'
import { isValidPackageName, isValidVersion } from '@shared/pluginScaffold'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'

const inputClass =
  'w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-[13px] text-cream outline-none transition-all placeholder:text-cream-faint focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--accent-soft)]'

const ERROR_KEYS: Record<PluginScaffoldError, I18nKey> = {
  'invalid-spec': 'author.error.invalidSpec',
  'invalid-grant': 'author.error.invalidGrant',
  'invalid-name': 'author.error.invalidName',
  'invalid-version': 'author.error.invalidVersion',
  'no-resources': 'author.error.noResources',
  'dir-missing': 'author.error.dirMissing',
  'unsafe-path': 'author.error.unsafePath',
  'dir-not-empty': 'author.error.dirNotEmpty',
  'write-failed': 'author.error.writeFailed'
}

const RESOURCE_ROWS = [
  { key: 'extension', icon: Wrench, labelKey: 'plugins.resource.extension', hintKey: 'author.resource.extensionHint' },
  { key: 'skill', icon: Sparkles, labelKey: 'plugins.resource.skill', hintKey: 'author.resource.skillHint' },
  { key: 'prompt', icon: MessageSquareText, labelKey: 'plugins.resource.prompt', hintKey: 'author.resource.promptHint' }
] as const

type ResourceKey = (typeof RESOURCE_ROWS)[number]['key']

const TEMPLATES: { key: PluginTemplate; labelKey: I18nKey }[] = [
  { key: 'blank', labelKey: 'author.template.blank' },
  { key: 'command', labelKey: 'author.template.command' },
  { key: 'tool-guard', labelKey: 'author.template.toolGuard' }
]

interface ScaffoldedPackage {
  output: PluginScaffoldOutput
  files: string[]
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error'
}

export default function PluginAuthorPage() {
  const t = useT()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('0.1.0')
  const [author, setAuthor] = useState('')
  const [parentDirectory, setParentDirectory] = useState<DirectoryGrant | null>(null)
  const [resources, setResources] = useState<Record<ResourceKey, boolean>>({
    extension: true,
    skill: false,
    prompt: false
  })
  const [template, setTemplate] = useState<PluginTemplate>('blank')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ key: I18nKey; detail?: string } | null>(null)
  const [result, setResult] = useState<ScaffoldedPackage | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [installLog, setInstallLog] = useState<string | null>(null)

  const pickDir = async () => {
    try {
      const grant = await window.electronAPI.selectPluginScaffoldDirectory()
      if (grant) setParentDirectory(grant)
    } catch (cause) {
      setError({ key: 'author.error.operationFailed', detail: errorDetail(cause) })
    }
  }

  // Renderer-side checks are UX only — the main process validates again.
  const validate = (): I18nKey | null => {
    if (!name.trim() || !description.trim() || !parentDirectory) return 'author.error.required'
    if (!isValidPackageName(name.trim())) return 'author.error.invalidName'
    if (!isValidVersion(version.trim())) return 'author.error.invalidVersion'
    if (!resources.extension && !resources.skill && !resources.prompt) {
      return 'author.error.noResources'
    }
    return null
  }

  const handleSubmit = async () => {
    if (submitting) return
    const invalid = validate()
    if (invalid) {
      setError({ key: invalid })
      return
    }
    if (!parentDirectory) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await window.electronAPI.scaffoldPlugin({
        name: name.trim(),
        displayName: displayName.trim() || undefined,
        description: description.trim(),
        version: version.trim(),
        author: author.trim() || undefined,
        parentGrantId: parentDirectory.id,
        extension: resources.extension,
        skill: resources.skill,
        prompt: resources.prompt,
        template
      })
      if (res.ok) {
        setResult({ output: res.output, files: res.files })
      } else {
        // Grants expire/are consumed by Main. Do not leave a visually selected
        // directory that can only fail again; the error asks the user to pick it
        // anew and the form returns to its normal required-location state.
        if (res.error === 'invalid-grant') setParentDirectory(null)
        setError({ key: ERROR_KEYS[res.error] ?? 'author.error.invalidSpec', detail: res.detail })
      }
    } catch (cause) {
      setError({ key: 'author.error.operationFailed', detail: errorDetail(cause) })
    } finally {
      setSubmitting(false)
    }
  }

  const handleInstall = async () => {
    if (!result || installing || installed) return
    setInstalling(true)
    setInstallLog(null)
    try {
      const res = await window.electronAPI.installScaffoldedPlugin(result.output.id)
      if (res.ok) {
        setInstalled(true)
        try {
          useAppStore.getState().setPackages(await window.electronAPI.listPackages())
        } catch (cause) {
          setInstallLog(errorDetail(cause))
        }
      } else {
        setInstallLog(res.log || 'install failed')
      }
    } catch (cause) {
      setInstallLog(errorDetail(cause))
    } finally {
      setInstalling(false)
    }
  }

  const handleReveal = async () => {
    if (!result) return
    try {
      const revealed = await window.electronAPI.revealScaffoldedPlugin(result.output.id)
      if (!revealed) setInstallLog(t('author.error.outputUnavailable'))
    } catch (cause) {
      setInstallLog(errorDetail(cause))
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <button
          onClick={() => navigate('/plugins')}
          className="app-no-drag flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
        >
          <ArrowLeft size={11} />
          {t('author.back')}
        </button>
        <Hammer size={15} className="text-accent" />
        <span className="text-[13px] font-medium text-cream">{t('author.title')}</span>
        <span className="text-xs text-cream-faint">{t('author.subtitle')}</span>
      </header>

      <div className="flex-1 overflow-y-auto p-5 pb-20">
        <div className="mx-auto max-w-[760px] space-y-4">
          {result ? (
            /* Success: file list + install / reveal actions */
            <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
              <div className="flex items-center gap-2">
                <Check size={14} className="text-emerald-500" />
                <span className="text-[13px] font-semibold text-cream">{t('author.done')}</span>
              </div>
              <div className="mt-1.5 font-mono text-[11px] break-all text-cream-faint">
                {result.output.name}
              </div>
              <div className="mt-3.5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                {t('author.files')}
              </div>
              <div className="mt-1.5 rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[11px] leading-5 text-cream-dim">
                {result.files.map((file) => (
                  <div key={file}>{file}</div>
                ))}
              </div>
              {installLog && (
                <pre className="mt-3 max-h-36 overflow-y-auto rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-red-600 dark:text-red-300">
                  {installLog}
                </pre>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={handleReveal}
                  className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[12px] text-cream-dim transition hover:border-ink-600 hover:text-cream"
                >
                  <FolderOpen size={12} />
                  {t('author.reveal')}
                </button>
                {installed ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-2 text-[12px] font-medium text-accent">
                    <Check size={12} />
                    {t('author.installed')}
                  </span>
                ) : (
                  <button
                    onClick={handleInstall}
                    disabled={installing}
                    className="flex items-center gap-1.5 rounded-full bg-cream px-4 py-2 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={12} />
                    {installing ? t('author.installing') : t('author.install')}
                  </button>
                )}
              </div>
            </section>
          ) : (
            <>
              {/* Package metadata */}
              <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
                <div className="space-y-3.5">
                  <Field label={t('author.name')} hint={t('author.nameHint')}>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="pi-my-tool"
                      className={`${inputClass} font-mono`}
                    />
                  </Field>
                  <Field label={t('author.displayName')}>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label={t('author.description')}>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t('author.descriptionPlaceholder')}
                      className={inputClass}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('author.version')}>
                      <input
                        type="text"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        className={`${inputClass} font-mono`}
                      />
                    </Field>
                    <Field label={t('author.author')}>
                      <input
                        type="text"
                        value={author}
                        onChange={(e) => setAuthor(e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </div>
              </section>

              {/* Contents: resource toggles + extension template */}
              <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
                <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                  {t('author.resources')}
                </div>
                <div className="grid gap-2">
                  {RESOURCE_ROWS.map((row) => {
                    const active = resources[row.key]
                    const Icon = row.icon
                    return (
                      <button
                        key={row.key}
                        onClick={() =>
                          setResources((current) => ({ ...current, [row.key]: !current[row.key] }))
                        }
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                          active
                            ? 'border-accent/60 bg-accent-soft'
                            : 'border-line hover:border-ink-600'
                        }`}
                      >
                        <Icon size={14} className={active ? 'text-accent' : 'text-cream-faint'} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-cream">
                            {t(row.labelKey)}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-cream-faint">
                            {t(row.hintKey)}
                          </span>
                        </span>
                        {active && <Check size={13} className="shrink-0 text-accent" />}
                      </button>
                    )
                  })}
                  {/* Themes are not scaffoldable yet — the JSON schema is unverified */}
                  <div className="flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 opacity-60">
                    <Palette size={14} className="text-cream-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-cream-dim">
                        {t('plugins.resource.theme')}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-cream-faint">
                        {t('author.themeNote')}
                      </span>
                    </span>
                  </div>
                </div>

                {resources.extension && (
                  <div className="mt-3.5">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cream-faint">
                      {t('author.template')}
                    </div>
                    <div className="grid gap-1.5">
                      {TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.key}
                          onClick={() => setTemplate(tpl.key)}
                          className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12px] transition ${
                            template === tpl.key
                              ? 'border-accent/60 bg-accent-soft text-cream'
                              : 'border-line text-cream-dim hover:border-ink-600 hover:text-cream'
                          }`}
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full border ${
                              template === tpl.key
                                ? 'border-accent bg-accent'
                                : 'border-cream-faint'
                            }`}
                          />
                          {t(tpl.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Location */}
              <section className="rounded-[16px] border border-line bg-ink-850 p-4 shadow-card">
                <Field label={t('author.location')} hint={t('author.locationHint')}>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1 truncate rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[13px] text-cream-dim">
                      {parentDirectory?.name || ' '}
                    </div>
                    <button
                      onClick={pickDir}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[12px] whitespace-nowrap text-cream-dim transition hover:border-ink-600 hover:text-cream"
                    >
                      <FolderOpen size={12} />
                      {t('author.browse')}
                    </button>
                  </div>
                </Field>
              </section>

              {error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-300">
                  {t(error.key, error.detail ? { detail: error.detail } : undefined)}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="flex items-center gap-1.5 rounded-full bg-cream px-5 py-2 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Hammer size={12} />
                  {submitting ? t('author.creating') : t('author.create')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-cream-faint">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-cream-faint">{hint}</span>}
    </label>
  )
}
