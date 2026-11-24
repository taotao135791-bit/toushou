import { useEffect, useMemo, useState } from 'react'
import { Check, KeyRound, RefreshCw, RotateCcw, Save, Search, Trash2 } from 'lucide-react'
import { isCustomProviderApi, matchesCatalogEndpoint } from '@shared/modelCatalog'
import type { CustomProviderInfo } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { defaultThinkingOptionsFor } from '../lib/thinking'
import { resolveRuntimeSettingDraft } from '../lib/runtimeModelDraft'
import { currentValueState } from '../lib/runtimeSelect'
import NativeLoginSection from './NativeLoginSection'

/**
 * Settings → Models (current profile). One coherent configuration form:
 *
 *   1. Provider dropdown  — the CLI provider registry (omp auth-broker list;
 *                              never empty just because the RPC probe failed)
 *   2. Model dropdown      — static catalog filtered by provider
 *                              (persisted via modelRoles.default)
 *   3. API key input       — direct paste, provider-validated by the runtime
 *                              (native login flow's paste-key prompt)
 *   4. Saved credentials   — every authenticated provider, independently
 *                              removable (omp auth-broker logout)
 *   5. Default thinking    — config defaultThinkingLevel (auto..max)
 *   6. Save / Reset        — explicit persist / delete config
 *
 * Runtime truth is always shown even when the persisted value is absent from
 * the catalog (synthetic "unavailable"/"unsupported" option). An empty
 * provider list renders an explicit error + retry — never a dead dropdown.
 */
export default function RuntimeModelSection({ customProviders, onAddCustomModel }: {
  customProviders: CustomProviderInfo[]
  onAddCustomModel: (provider?: string) => void
}) {
  const overview = useAppStore((s) => s.runtimeOverview)
  const runtimeModels = useAppStore((s) => s.runtimeModels)
  const runtimeModelCatalog = useAppStore((s) => s.runtimeModelCatalog)
  const loadRuntimeModelCatalog = useAppStore((s) => s.loadRuntimeModelCatalog)
  const selectRuntimeDefaultModel = useAppStore((s) => s.selectRuntimeDefaultModel)
  const setRuntimeDefaultThinking = useAppStore((s) => s.setRuntimeDefaultThinking)
  const setRuntimeApiKey = useAppStore((s) => s.setRuntimeApiKey)
  const logoutProvider = useAppStore((s) => s.logoutProvider)
  const loadRuntimeOverview = useAppStore((s) => s.loadRuntimeOverview)
  const loadRuntimeModels = useAppStore((s) => s.loadRuntimeModels)
  const loginState = useAppStore((s) => s.loginState)
  const t = useT()

  const defaultModel = overview?.modelState.defaultModel ?? ''
  const defaultThinking = overview?.modelState.defaultThinkingLevel ?? ''
  const providers = useMemo(() => {
    const listed = new Map(overview?.providers.map(entry => [entry.id, entry]))
    for (const { provider: id } of runtimeModels) {
      if (!listed.has(id)) listed.set(id, { id, name: id, available: true, authenticated: false })
    }
    for (const { id } of customProviders) {
      if (!listed.has(id)) listed.set(id, { id, name: id, available: false, authenticated: false })
    }
    return [...listed.values()]
  }, [overview?.providers, runtimeModels, customProviders])

  const [provider, setProvider] = useState('')
  // Keep unsaved choices separate from runtime truth. A delayed overview is
  // allowed to update untouched fields, but must never erase a user's choice
  // before they press Save. `''` is a deliberate automatic-default choice;
  // only `null` means "follow the runtime".
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const [thinkingDraft, setThinkingDraft] = useState<string | null>(null)
  const model = resolveRuntimeSettingDraft(modelDraft, defaultModel)
  const thinking = resolveRuntimeSettingDraft(thinkingDraft, defaultThinking)
  const [keyInput, setKeyInput] = useState('')
  const [providerQuery, setProviderQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const retryOverview = () => {
    setLoadFailed(false)
    loadRuntimeOverview(true).catch(() => setLoadFailed(true))
  }

  useEffect(() => {
    // Seed the provider from the persisted model's provider (never overwrite
    // a provider the user already picked).
    const defaultProvider = defaultModel.split('/')[0]
    if (defaultProvider) setProvider((p) => p || defaultProvider)
  }, [defaultModel])

  // Load the full static catalog once (concrete models, key-independent).
  useEffect(() => {
    void loadRuntimeModelCatalog()
  }, [loadRuntimeModelCatalog])

  // Defensive: the settings page normally loads the overview before this
  // section renders — when it didn't, load it here instead of showing a
  // dead empty form.
  useEffect(() => {
    if (!overview) retryOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sortedProviders = [...providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name)
  )
  // Name filter over the (already connected-first) registry. The current
  // selection stays visible even when it does not match the query.
  const providerQueryNorm = providerQuery.trim().toLowerCase()
  const visibleProviders = providerQueryNorm
    ? sortedProviders.filter(
        (p) => p.id === provider || p.name.toLowerCase().includes(providerQueryNorm)
      )
    : sortedProviders
  const authenticatedProviders = providers
    .filter((p) => p.authenticated)
    .sort((a, b) => a.name.localeCompare(b.name))
  const selectedProvider = providers.find((item) => item.id === provider)
  // API-key writes and logout mutate the same runtime credential store as a
  // native login. Keep the direct-key route available, but do not let the two
  // auth mechanisms race each other while a native flow is in progress.
  const nativeLoginActive =
    loginState.status === 'starting' ||
    loginState.status === 'waiting_for_browser' ||
    loginState.status === 'waiting_for_input' ||
    loginState.status === 'waiting_for_select' ||
    loginState.status === 'waiting_for_confirm' ||
    loginState.status === 'verifying'

  // Include discovered model IDs even when an older static catalog lists the provider.
  const catalogByProvider = runtimeModelCatalog.filter((m) => m.provider === provider)
  const liveByProvider = runtimeModels.filter((m) => m.provider === provider)
  const configured = customProviders.find(p => p.id === provider)
  const trustedCatalog = configured?.baseUrl
    ? catalogByProvider.filter(m => matchesCatalogEndpoint(m, configured) && !configured.models.some(row => row.id === m.id && row.hasCustomTransport))
    : catalogByProvider
  const canExtend = configured?.api ? isCustomProviderApi(configured.api) &&
    (configured.api !== 'google-generative-ai' || catalogByProvider.some(m => matchesCatalogEndpoint(m, configured)))
    : !catalogByProvider.length || catalogByProvider.some(m => !!m.baseUrl && isCustomProviderApi(m.api))
  const entries = new Map(trustedCatalog.map(m => [m.selector, m]))
  for (const row of configured?.models ?? []) {
    const selector = provider + '/' + row.id
    if (!entries.has(selector)) entries.set(selector, {
      id: row.id, provider, selector, name: row.name || row.id, input: row.input ?? undefined,
      contextWindow: row.contextWindow, reasoning: false, thinking: []
    })
  }
  for (const entry of liveByProvider) entries.set(entry.selector, entry)
  const modelOptions = [...entries.values()]
  const selectedEntry = entries.get(model)
  const selectedCapabilities = [
    selectedEntry?.input?.length ? t(selectedEntry.input.includes('image') ? 'settings.modelInputImage' : 'settings.modelInputText') : '',
    selectedEntry?.contextWindow ? t('settings.modelContextValue', { size: selectedEntry.contextWindow.toLocaleString() }) : ''
  ].filter(Boolean).join(' · ')
  const modelSelectors = modelOptions.map((m) => m.selector)
  const modelState = currentValueState(model, modelSelectors)

  const liveEfforts = liveByProvider.find((m) => m.selector === (model || defaultModel) && m.thinking.length > 0)
  const defaultEntry =
    liveEfforts ?? modelOptions.find((m) => m.selector === model) ??
    modelOptions.find((m) => m.selector === defaultModel) ??
    runtimeModels.find((m) => m.selector === model) ??
    runtimeModels.find((m) => m.selector === defaultModel)
  const thinkingOptions = defaultThinkingOptionsFor(defaultEntry)
  const thinkingState = currentValueState(thinking, thinkingOptions)

  const flashSaved = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const [catalogNote, setCatalogNote] = useState<string | null>(null)

  const refreshCatalog = async () => {
    if (catalogRefreshing) return
    setCatalogRefreshing(true)
    setCatalogNote(null)
    const res = await window.electronAPI.runtimeRefreshModelCatalog()
    if (res.ok) {
      await Promise.all([loadRuntimeModelCatalog(), loadRuntimeModels()])
      setCatalogNote(t('settings.catalogRefreshed', { count: res.providers ?? 0 }))
    } else {
      setCatalogNote(t('settings.saveFailed', { error: res.error ?? 'failed' }))
    }
    setCatalogRefreshing(false)
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    const modelRes = await selectRuntimeDefaultModel(model)
    const thinkingRes = await setRuntimeDefaultThinking(thinking)
    setSaving(false)
    if (modelRes.ok && thinkingRes.ok) {
      flashSaved()
      await loadRuntimeOverview(true)
      await loadRuntimeModels()
      // The final refresh above is now authoritative, so release the local
      // drafts and resume following future runtime changes.
      setModelDraft(null)
      setThinkingDraft(null)
    } else {
      setError(modelRes.error ?? thinkingRes.error ?? 'failed')
    }
  }

  const reset = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    const modelRes = await selectRuntimeDefaultModel('')
    const thinkingRes = await setRuntimeDefaultThinking('')
    setSaving(false)
    if (modelRes.ok && thinkingRes.ok) {
      setProvider('')
      flashSaved()
      await loadRuntimeOverview(true)
      await loadRuntimeModels()
      setModelDraft(null)
      setThinkingDraft(null)
    } else {
      setError(modelRes.error ?? thinkingRes.error ?? 'failed')
    }
  }

  const saveKey = async () => {
    if (!provider || !keyInput.trim() || keyBusy || nativeLoginActive) return
    setKeyBusy(true)
    setError(null)
    try {
      const res = await setRuntimeApiKey(provider, keyInput.trim())
      if (res.ok) {
        setKeyInput('')
        flashSaved()
        await loadRuntimeModels()
      } else {
        setError(res.error ?? 'failed')
      }
    } catch (err) {
      // A thrown IPC call must never leave the button spinning forever.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setKeyBusy(false)
    }
  }

  const removeCredential = async (providerId: string) => {
    if (!providerId || keyBusy || nativeLoginActive) return
    setKeyBusy(true)
    setError(null)
    try {
      const res = await logoutProvider(providerId)
      if (!res.ok) setError(res.error ?? 'failed')
      else flashSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setKeyBusy(false)
    }
  }

  const selectCls =
    'h-8 min-w-52 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none focus:border-ink-600'
  const inputCls =
    'h-8 min-w-52 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none placeholder:text-cream-faint focus:border-ink-600 disabled:opacity-40'
  const buttonCls =
    'flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'

  if (!overview) {
    return (
      <section className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
        <div className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
          {t('settings.models')}
        </div>
        <div className="px-4 py-3">
          {loadFailed ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-red-500">{t('settings.runtimeError')}</span>
              <button onClick={retryOverview} className={buttonCls}>
                <RefreshCw size={11} />
                {t('settings.runtimeRetry')}
              </button>
            </span>
          ) : (
            <p className="text-[11px] leading-relaxed text-cream-faint">
              {t('settings.runtimeLoading')}
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
      <div className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
        {t('settings.models')}
      </div>

      <div className="divide-y divide-line/60 px-4">
        {/* Provider */}
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-[13px] text-cream">{t('settings.provider')}</span>
          {providers.length === 0 ? (
            // Registry AND probe both failed — say so and offer a retry
            // instead of rendering a dead empty dropdown.
            <span className="flex items-center gap-2">
              <span className="text-xs text-red-500">{t('settings.runtimeError')}</span>
              <button onClick={retryOverview} className={buttonCls}>
                <RefreshCw size={11} />
                {t('settings.runtimeRetry')}
              </button>
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="relative">
                <Search
                  size={11}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-cream-faint"
                />
                <input
                  value={providerQuery}
                  onChange={(e) => setProviderQuery(e.target.value)}
                  placeholder={t('settings.provider')}
                  aria-label={t('settings.provider')}
                  className="h-8 w-36 rounded-lg border border-line bg-ink-850 pl-7 pr-2 text-[12.5px] text-cream outline-none placeholder:text-cream-faint focus:border-ink-600"
                />
              </span>
              <select
                value={provider}
                onChange={(e) => {
                  const next = e.target.value
                  setProvider(next)
                  // Switching provider also makes an explicit automatic choice
                  // local; otherwise a late overview for the old provider can
                  // populate this picker again before the user chooses a model.
                  if (model.split('/')[0] !== next) setModelDraft('')
                  setKeyInput('')
                }}
                className={selectCls}
              >
                <option value="">{t('settings.providerUnselected')}</option>
                {visibleProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.authenticated ? ` · ${t('settings.authConnected')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Model */}
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-[13px] text-cream">{t('settings.defaultModel')}</span>
          <div className="flex min-w-0 flex-col items-end gap-1">
            <select aria-label={t('settings.defaultModel')} value={modelState.value} onChange={e => {
              if (e.target.value === '__custom__') onAddCustomModel(canExtend ? provider : undefined)
              else setModelDraft(e.target.value)
            }} className={selectCls}>
              <option value="">{t('settings.modelRuntimeDefault')}</option>
              {modelState.unavailable && (
                <option value={modelState.value}>
                  {modelState.value} · {t('settings.modelUnavailable')}
                </option>
              )}
              {/* Keep a valid selected model in the DOM. Removing it makes a
                  controlled native <select> fall back to its first option,
                  visually (and interactively) reverting to “Auto”. */}
              {modelOptions.map((m) => (
                <option key={m.selector} value={m.selector}>
                  {m.name}
                </option>
              ))}
              {provider && <option value="__custom__">{t(canExtend ? 'settings.customModelIds' : 'settings.customProviderAdd')}…</option>}
            </select>
            {selectedCapabilities && <span className="text-[11px] text-cream-faint">{selectedCapabilities}</span>}
            {provider && !canExtend && <span className="text-[11px] text-cream-faint">{t('settings.providerCatalogOnly')}</span>}
          </div>
        </div>
        {modelState.unavailable && (
          <p className="px-4 pb-2 text-[11px] leading-relaxed text-cream-faint">
            {t('settings.modelUnavailableNote')}
          </p>
        )}

        {/* API key */}
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-[13px] text-cream">{t('settings.apiKey')}</span>
          <span className="flex items-center gap-2">
            {provider ? (
              <>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveKey()
                  }}
                  placeholder={t('settings.apiKeyPlaceholder')}
                  disabled={keyBusy || nativeLoginActive}
                  className={inputCls}
                />
                <button
                  onClick={saveKey}
                  disabled={keyBusy || nativeLoginActive || !keyInput.trim()}
                  className={buttonCls}
                >
                  <KeyRound size={12} />
                  {keyBusy ? t('settings.saving') : t('settings.saveKey')}
                </button>
              </>
            ) : (
              <span className="text-xs text-cream-faint">{t('settings.selectProviderFirst')}</span>
            )}
          </span>
        </div>

        {/* Browser / device-code / interactive provider flows. This is
            intentionally separate from the direct API-key form above, while
            sharing its currently selected provider. */}
        <NativeLoginSection
          providerId={provider}
          providerName={selectedProvider?.name}
          providerAvailable={selectedProvider?.available ?? false}
          capability={overview.capabilities.nativeLogin}
        />

        {/* Saved credentials — one key per provider, independently removable */}
        <div className="py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-cream">{t('settings.savedCredentials')}</span>
            {authenticatedProviders.length === 0 && (
              <span className="text-xs text-cream-faint">{t('settings.savedCredentialsEmpty')}</span>
            )}
          </div>
          {authenticatedProviders.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {authenticatedProviders.map((p) => (
                <span
                  key={p.id}
                  className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-cream-dim"
                >
                  {p.name}
                  <button
                    onClick={() => void removeCredential(p.id)}
                    disabled={keyBusy || nativeLoginActive}
                    title={t('settings.clearKey')}
                    className="text-cream-faint transition-colors hover:text-red-500 disabled:opacity-40"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-cream-faint">
            {t('settings.savedCredentialsNote')}
          </p>
        </div>

        {/* Default thinking */}
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-[13px] text-cream">{t('settings.thinkingCurrent')}</span>
          <select
            value={thinkingState.value}
            onChange={(e) => setThinkingDraft(e.target.value)}
            className={selectCls}
          >
            <option value="">{t('settings.thinkingReset')}</option>
            {thinkingState.unavailable && (
              <option value={thinkingState.value}>
                {thinkingState.value} · {t('settings.thinkingUnsupported')}
              </option>
            )}
            {/* Same rule as the model picker: the current valid value must
                remain an option, otherwise the native control displays its
                first entry instead. */}
            {thinkingOptions.map((level) => (
              <option key={level} value={level}>
                {level === 'auto' ? t('settings.thinkingAuto') : level}
              </option>
            ))}
          </select>
        </div>
        {thinkingState.unavailable && (
          <p className="px-4 pb-2 text-[11px] leading-relaxed text-amber-500">
            {thinkingState.value} · {t('settings.thinkingUnsupported')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line/60 px-4 py-3">
        {saved && (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check size={11} />
            {t('settings.saved')}
          </span>
        )}
        {catalogNote && <span className="text-xs text-cream-faint">{catalogNote}</span>}
        <button
          onClick={refreshCatalog}
          disabled={catalogRefreshing || saving}
          className={buttonCls}
          title={t('settings.refreshCatalogHint')}
        >
          <RotateCcw size={12} className={catalogRefreshing ? 'animate-spin' : ''} />
          {t('settings.refreshCatalog')}
        </button>
        <button onClick={reset} disabled={saving} className={buttonCls} title={t('settings.resetModel')}>
          <RotateCcw size={12} />
          {t('settings.resetModel')}
        </button>
        <button onClick={save} disabled={saving} className={buttonCls} title={t('settings.saveModel')}>
          <Save size={12} />
          {t('settings.saveModel')}
        </button>
      </div>

      {error && (
        <p className="px-4 pb-3 text-xs text-red-500">{t('settings.saveFailed', { error })}</p>
      )}
      <p className="px-4 pb-3 text-[11px] leading-relaxed text-cream-faint">
        {t('settings.modelNoteCurrent')}
      </p>
    </section>
  )
}
