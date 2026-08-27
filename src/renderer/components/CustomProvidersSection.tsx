import { useEffect, useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  CustomProviderApi,
  CustomProviderError,
  CustomProviderInfo,
  CustomProviderSpec
} from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'

/**
 * Settings → Custom providers (current profile only). opencode-style custom
 * endpoints backed by omp's ~/.omp/agent/models.yml — the escape hatch from
 * the built-in provider registry. Saves are verified against the real runtime
 * in the main process (rolled back when omp doesn't recognize the provider);
 * the renderer only renders the honest outcome.
 */

interface FormState {
  id: string
  /** Editing an existing provider — the id is the models.yml key, immutable. */
  locked: boolean
  baseUrl: string
  api: CustomProviderApi
  authNone: boolean
  apiKey: string
  /** Editing + key already stored: empty input keeps it. */
  hasStoredKey: boolean
  discovery: boolean
  /**
   * Preset model ids, one per line ("id" or "id 显示名"). Relay/gateway
   * endpoints have a fixed model set, so plain text beats per-row editors.
   */
  modelsText: string
}

const emptyForm = (): FormState => ({
  id: '',
  locked: false,
  baseUrl: '',
  api: 'openai-completions',
  authNone: false,
  apiKey: '',
  hasStoredKey: false,
  discovery: false,
  modelsText: ''
})

const formFromProvider = (p: CustomProviderInfo): FormState => ({
  id: p.id,
  locked: true,
  baseUrl: p.baseUrl,
  api: (['openai-completions', 'openai-responses', 'anthropic-messages'] as const).includes(
    p.api as CustomProviderApi
  )
    ? (p.api as CustomProviderApi)
    : 'openai-completions',
  authNone: p.authNone,
  apiKey: '',
  hasStoredKey: p.hasKey,
  discovery: p.discovery,
  modelsText: p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} ${m.name}` : m.id)).join('\n')
})

/** Parse the one-model-per-line textarea: "id" or "id 显示名". */
export function parseModelsText(text: string): { id: string; name: string }[] {
  const seen = new Set<string>()
  const out: { id: string; name: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const space = trimmed.search(/\s/)
    const id = space === -1 ? trimmed : trimmed.slice(0, space)
    const name = space === -1 ? '' : trimmed.slice(space).trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

export default function CustomProvidersSection() {
  const overview = useAppStore((s) => s.runtimeOverview)
  const loadRuntimeOverview = useAppStore((s) => s.loadRuntimeOverview)
  const loadRuntimeModels = useAppStore((s) => s.loadRuntimeModels)
  const t = useT()

  const [providers, setProviders] = useState<CustomProviderInfo[]>([])
  const [readError, setReadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const refresh = async () => {
    const res = await window.electronAPI.customProvidersList()
    if (res.ok) {
      setProviders(res.providers)
      setReadError(null)
    } else {
      setProviders([])
      setReadError(res.detail ?? res.error)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // models.yml is a current-omp mechanism; legacy pi never shows this section.
  if (overview?.profile !== 'current') return null

  const errorText = (code: CustomProviderError | 'invalid-spec', detail?: string): string => {
    switch (code) {
      case 'verify-failed':
        return t('settings.customProviderVerifyFailed')
      case 'invalid-id':
        return t('settings.customProviderInvalidId')
      case 'invalid-base-url':
        return t('settings.customProviderInvalidBaseUrl')
      case 'invalid-api-key':
        return t('settings.customProviderInvalidApiKey')
      case 'invalid-models':
        return t('settings.customProviderInvalidModels')
      default:
        return t('settings.saveFailed', { error: detail ?? code })
    }
  }

  const buildSpec = (f: FormState): CustomProviderSpec => ({
    id: f.id.trim(),
    baseUrl: f.baseUrl.trim(),
    api: f.api,
    apiKey: f.apiKey.trim() ? f.apiKey.trim() : undefined,
    authNone: f.authNone,
    discovery: f.discovery,
    models: f.discovery ? [] : parseModelsText(f.modelsText)
  })

  const save = async () => {
    if (!form || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    const res = await window.electronAPI.customProvidersSave(buildSpec(form))
    setSaving(false)
    if (res.ok) {
      setForm(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      if (!res.verified) setNotice(t('settings.customProviderSavedUnverified'))
      await refresh()
      // Make the new models selectable immediately (picker + default model).
      await loadRuntimeOverview(true)
      await loadRuntimeModels()
    } else {
      setError(errorText(res.error, 'detail' in res ? res.detail : undefined))
    }
  }

  const remove = async (id: string) => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    const res = await window.electronAPI.customProvidersDelete(id)
    setDeleting(false)
    setConfirmDeleteId(null)
    if (res.ok) {
      await refresh()
      await loadRuntimeOverview(true)
      await loadRuntimeModels()
    } else {
      setError(t('settings.saveFailed', { error: res.error ?? 'failed' }))
    }
  }

  const patchForm = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f))

  const selectCls =
    'h-8 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none focus:border-ink-600 disabled:opacity-40'
  const inputCls =
    'h-8 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none placeholder:text-cream-faint focus:border-ink-600 disabled:opacity-40'
  const buttonCls =
    'flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'

  return (
    <section className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
          {t('settings.customProviders')}
        </span>
        {!form && (
          <button onClick={() => { setForm(emptyForm()); setError(null); setNotice(null) }} className={buttonCls}>
            <Plus size={12} />
            {t('settings.customProviderAdd')}
          </button>
        )}
      </div>

      <div className="divide-y divide-line/60 px-4">
        {readError && (
          <p className="py-2.5 text-[11px] leading-relaxed text-red-500">
            {t('settings.customProvidersReadError', { detail: readError })}
          </p>
        )}

        {!readError && providers.length === 0 && !form && (
          <p className="py-3 text-xs text-cream-faint">{t('settings.customProvidersEmpty')}</p>
        )}

        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="text-[13px] text-cream">{p.id}</div>
              <div className="truncate text-[11px] text-cream-faint">
                {p.baseUrl} ·{' '}
                {p.discovery
                  ? t('settings.customProviderAutoModels')
                  : t('settings.customProviderModelCount', { count: p.models.length })}
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => { setForm(formFromProvider(p)); setError(null); setNotice(null) }}
                disabled={deleting}
                title={t('settings.customProviderEdit')}
                className="text-cream-faint transition-colors hover:text-cream disabled:opacity-40"
              >
                <Pencil size={13} />
              </button>
              {confirmDeleteId === p.id ? (
                <>
                  <button
                    onClick={() => void remove(p.id)}
                    disabled={deleting}
                    className="text-[11px] font-medium text-red-500 hover:underline disabled:opacity-40"
                  >
                    {t('settings.customProviderDeleteConfirm')}
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-cream-faint transition-colors hover:text-cream"
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(p.id)}
                  disabled={deleting}
                  title={t('settings.customProviderDelete')}
                  className="text-cream-faint transition-colors hover:text-red-500 disabled:opacity-40"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </span>
          </div>
        ))}

        {form && (
          <div className="space-y-2.5 py-3">
            {/* id + api */}
            <div className="flex items-center gap-2">
              <input
                value={form.id}
                onChange={(e) => patchForm({ id: e.target.value })}
                disabled={form.locked || saving}
                placeholder={t('settings.customProviderId')}
                title={form.locked ? undefined : t('settings.customProviderIdHint')}
                className={`${inputCls} w-44 font-mono`}
              />
              <select
                value={form.api}
                onChange={(e) => patchForm({ api: e.target.value as CustomProviderApi })}
                disabled={saving}
                className={selectCls}
                title={t('settings.customProviderApi')}
              >
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
              </select>
            </div>

            <input
              value={form.baseUrl}
              onChange={(e) => patchForm({ baseUrl: e.target.value })}
              disabled={saving}
              placeholder="https://api.example.com/v1"
              className={`${inputCls} w-full font-mono`}
            />

            {/* auth: key paste, or no-key local server */}
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => patchForm({ apiKey: e.target.value })}
                disabled={saving || form.authNone}
                placeholder={
                  form.hasStoredKey
                    ? t('settings.customProviderKeyKeep')
                    : t('settings.apiKeyPlaceholder')
                }
                className={`${inputCls} min-w-52 flex-1`}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-cream-dim">
                <input
                  type="checkbox"
                  checked={form.authNone}
                  onChange={(e) => patchForm({ authNone: e.target.checked })}
                  disabled={saving}
                />
                {t('settings.customProviderAuthNone')}
              </label>
            </div>

            {/* model source: discovery, or explicit rows */}
            <label className="flex items-center gap-1.5 text-[12px] text-cream-dim">
              <input
                type="checkbox"
                checked={form.discovery}
                onChange={(e) => patchForm({ discovery: e.target.checked })}
                disabled={saving}
              />
              {t('settings.customProviderDiscovery')}
            </label>

            {!form.discovery && (
              <div>
                <textarea
                  value={form.modelsText}
                  onChange={(e) => patchForm({ modelsText: e.target.value })}
                  disabled={saving}
                  rows={4}
                  placeholder={t('settings.customProviderModelsPlaceholder')}
                  className={`${inputCls} h-auto w-full py-2 font-mono leading-6`}
                />
                <p className="mt-1 text-[11px] text-cream-faint">
                  {t('settings.customProviderModelsHint')}
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} disabled={saving} className={buttonCls}>
                {t('settings.customProviderCancel')}
              </button>
              <button onClick={save} disabled={saving} className={buttonCls}>
                {saving ? t('settings.saving') : t('settings.customProviderSave')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-line/60 px-4 py-3">
        {saved && (
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check size={11} />
            {t('settings.saved')}
          </span>
        )}
        {error && <p className="mb-1 text-xs text-red-500">{error}</p>}
        {notice && <p className="mb-1 text-xs text-amber-500">{notice}</p>}
        <p className="text-[11px] leading-relaxed text-cream-faint">
          {t('settings.customProvidersNote')}
        </p>
      </div>
    </section>
  )
}
