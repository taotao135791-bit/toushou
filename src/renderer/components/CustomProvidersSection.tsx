import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  CustomProviderApi,
  CustomProviderError,
  CustomProviderInfo,
  CustomProviderModelSpec,
  CustomProviderSpec,
  CustomProvidersListResult,
  RuntimeModelInfo
} from '@shared/types'
import { GENERIC_CUSTOM_PROVIDER_APIS, isCustomProviderApi, matchesCatalogEndpoint } from '@shared/modelCatalog'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import CustomProviderModelPicker, { parseModelsText } from './CustomProviderModelPicker'
import JellyToggle from './effects/JellyToggle'

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
  api: string
  authNone: boolean
  apiKey: string
  /** Editing + key already stored: empty input keeps it. */
  hasStoredKey: boolean
  discovery: boolean
  showCustomIds: boolean
  modelsText: string
  modelDetails: Map<string, CustomProviderModelSpec>
  savedModelIds: ReadonlySet<string>
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
  modelDetails: new Map(),
  savedModelIds: new Set(),
  modelsText: '',
  showCustomIds: false
})

const formFromProvider = (p: CustomProviderInfo): FormState => ({
  id: p.id,
  locked: true,
  baseUrl: p.baseUrl,
  api: p.api || 'openai-completions',
  authNone: p.authNone,
  apiKey: '',
  hasStoredKey: p.hasKey,
  discovery: p.discovery,
  showCustomIds: false,
  savedModelIds: new Set(p.models.map(m => m.id)),
  modelDetails: new Map(p.models.map(m => [m.id, m])),
  modelsText: p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} ${m.name}` : m.id)).join('\n')
})

function presetEndpoint(catalog: RuntimeModelInfo[], id: string) {
  const entry = catalog.find(m => m.provider === id && m.baseUrl && isCustomProviderApi(m.api))
  return entry?.baseUrl && entry.api ? { baseUrl: entry.baseUrl, api: entry.api } : undefined
}

function openProviderForm(id: string, catalog: RuntimeModelInfo[], existing?: CustomProviderInfo): FormState {
  if (!existing) return { ...emptyForm(), id, ...presetEndpoint(catalog, id) }
  const next = formFromProvider(existing)
  const native = catalog.find(m => m.provider === id && (!existing.api || m.api === existing.api) &&
    (!existing.baseUrl || m.baseUrl?.replace(/\/+$/, '') === existing.baseUrl.replace(/\/+$/, '')))
  return { ...next, api: existing.api || native?.api || next.api, baseUrl: existing.baseUrl || native?.baseUrl || '' }
}

export default function CustomProvidersSection({ listing, refresh, requestedProvider, onRequestHandled }: {
  listing: CustomProvidersListResult | null
  refresh: () => Promise<void>
  requestedProvider: { id?: string } | null
  onRequestHandled: () => void
}) {
  const catalog = useAppStore(s => s.runtimeModelCatalog)
  const sectionRef = useRef<HTMLElement>(null)
  const overview = useAppStore((s) => s.runtimeOverview)
  const loadRuntimeOverview = useAppStore((s) => s.loadRuntimeOverview)
  const loadRuntimeModels = useAppStore((s) => s.loadRuntimeModels)
  const t = useT()

  const providers = listing?.ok ? listing.providers : []
  const readError = listing && !listing.ok ? listing.detail ?? listing.error : null
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!requestedProvider || !listing) return
    const id = requestedProvider.id
    if (id) {
      const existing = listing.ok ? listing.providers.find(p => p.id === id) : undefined
      setForm(current => ({
        ...(current?.id === id ? current : openProviderForm(id, catalog, existing)),
        showCustomIds: true
      }))
    } else {
      setForm(emptyForm())
    }
    setError(null)
    setNotice(null)
    onRequestHandled()
    sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [requestedProvider, listing, catalog, onRequestHandled])

  const id = form?.id.trim()
  const api = form?.api
  const baseUrl = form?.baseUrl
  const models = form?.modelDetails
  const presets = useMemo(() => {
    const matching = new Map<string, RuntimeModelInfo>()
    if (!id || !api || !baseUrl) return matching
    for (const entry of catalog) {
      if (entry.provider === id && !models?.get(entry.id)?.hasCustomTransport &&
          matchesCatalogEndpoint(entry, { id, api, baseUrl })) {
        matching.set(entry.id, entry)
      }
    }
    return matching
  }, [id, api, baseUrl, catalog, models])
  const needsContext = form && !form.discovery && parseModelsText(form.modelsText).some(({ id }) =>
    !form.savedModelIds.has(id) && !presets.get(id)?.contextWindow && !form.modelDetails.get(id)?.contextWindow
  )

  const knownProvider = id ? catalog.some(entry => entry.provider === id) : false
  const nativeEndpoint = id ? presetEndpoint(catalog, id) : undefined
  const google = form?.api === 'google-generative-ai'
  const googleEndpoint = google && form && catalog.some(entry => matchesCatalogEndpoint(entry, form))
  const formIssue = !form ? null
    : !form.locked && providers.some(p => p.id === id) ? t('settings.providerIdInUse')
    : !form.locked && knownProvider && !nativeEndpoint ? t('settings.providerIdReserved')
    : !isCustomProviderApi(form.api) ? t('settings.providerCatalogOnly')
    : google && !googleEndpoint ? t('settings.providerNativeEndpoint')
    : null

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

  const buildSpec = (f: FormState, api: CustomProviderApi): CustomProviderSpec => ({
    id: f.id.trim(),
    baseUrl: f.baseUrl.trim(),
    api,
    apiKey: f.apiKey.trim() ? f.apiKey.trim() : undefined,
    authNone: f.authNone,
    discovery: f.discovery,
    models: f.discovery ? [] : parseModelsText(f.modelsText).map(row => ({ ...f.modelDetails.get(row.id), ...row }))
  })

  const save = async () => {
    if (!form || !isCustomProviderApi(form.api) || saving || needsContext || formIssue) return
    setSaving(true)
    setError(null)
    setNotice(null)
    const res = await window.electronAPI.customProvidersSave(buildSpec(form, form.api))
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
    <section ref={sectionRef} className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
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
                onClick={() => { setForm(openProviderForm(p.id, catalog, p)); setError(null); setNotice(null) }}
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
                list="custom-provider-ids"
                onChange={(e) => {
                  const id = e.target.value
                  const prior = presetEndpoint(catalog, form.id)
                  const next = presetEndpoint(catalog, id)
                  const canFill = !form.baseUrl || form.baseUrl === prior?.baseUrl
                  const endpoint = canFill ? next ?? { baseUrl: '' } : {}
                  patchForm({
                    id, ...endpoint,
                    ...(canFill && !next ? { api: 'openai-completions' } : {}),
                    ...(canFill && next?.api === 'google-generative-ai' ? { discovery: false, authNone: false } : {})
                  })
                }}
                disabled={form.locked || saving}
                placeholder={t('settings.customProviderId')}
                title={form.locked ? undefined : t('settings.customProviderIdHint')}
                className={`${inputCls} w-44 font-mono`}
              />
              <datalist id="custom-provider-ids">
                {overview.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </datalist>
              <select
                value={form.api}
                onChange={e => patchForm({ api: e.target.value, ...(e.target.value === 'google-generative-ai' ? { discovery: false, authNone: false } : {}) })}
                disabled={saving || !isCustomProviderApi(form.api)}
                className={selectCls}
                title={t('settings.customProviderApi')}
              >
                {GENERIC_CUSTOM_PROVIDER_APIS.map(api => <option key={api} value={api}>{api}</option>)}
                {(google || nativeEndpoint?.api === 'google-generative-ai') &&
                  <option value="google-generative-ai">google-generative-ai</option>}
                {!isCustomProviderApi(form.api) && <option value={form.api}>{form.api}</option>}
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
              <div className="flex shrink-0 items-center gap-2 text-[12px] text-cream-dim">
                <JellyToggle
                  size="sm"
                  checked={form.authNone}
                  onChange={(value) => patchForm({ authNone: value })}
                  disabled={saving || (google && !form.authNone)}
                  aria-label={t('settings.customProviderAuthNone')}
                />
                <span>{t('settings.customProviderAuthNone')}</span>
              </div>
            </div>

            {nativeEndpoint && !form.hasStoredKey && form.baseUrl === nativeEndpoint.baseUrl &&
              <p className="text-[11px] text-cream-faint">{t('settings.customModelKeyNote')}</p>}

            {/* model source: discovery, or explicit rows */}
            <div className="flex items-center gap-2 text-[12px] text-cream-dim">
              <JellyToggle
                size="sm"
                checked={form.discovery}
                onChange={(value) => patchForm({ discovery: value })}
                disabled={saving || (google && !form.discovery)}
                aria-label={t('settings.customProviderDiscovery')}
              />
              <span>{t('settings.customProviderDiscovery')}</span>
            </div>

            {formIssue && <p className="text-xs text-amber-600 dark:text-amber-400">{formIssue}</p>}
            {!form.discovery && isCustomProviderApi(form.api) && form.id.trim() && <CustomProviderModelPicker presets={presets} savedModelIds={form.savedModelIds} text={form.modelsText}
              details={form.modelDetails} disabled={saving} custom={form.showCustomIds}
              onCustomChange={showCustomIds => patchForm({ showCustomIds })}
              onText={modelsText => patchForm({ modelsText })}
              onDetails={model => patchForm({ modelDetails: new Map(form.modelDetails).set(model.id, model) })} />}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} disabled={saving} className={buttonCls}>
                {t('settings.customProviderCancel')}
              </button>
              <button onClick={save} disabled={saving || !!needsContext || !!formIssue} className={buttonCls}>
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
