import { useEffect, useState } from 'react'
import { Check, KeyRound, ShieldCheck } from 'lucide-react'
import { ModelConfig, PI_PROVIDERS, PiModel } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'

const inputCls =
  'h-8 min-w-0 flex-1 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none placeholder:text-cream-faint focus:border-ink-600'
const selectCls =
  'h-8 min-w-44 rounded-lg border border-line bg-ink-850 px-2.5 text-[12.5px] text-cream outline-none focus:border-ink-600'
const buttonCls =
  'flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-ink-600 hover:text-cream disabled:opacity-40'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-line bg-ink-850 shadow-card">
      <div className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-cream-faint">
        {title}
      </div>
      <div className="divide-y divide-line/60 px-4">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-[13px] text-cream">{label}</span>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="py-2.5 text-[11px] leading-relaxed text-cream-faint">{children}</p>
}

const THINKING_LEVELS: Array<ModelConfig['defaultThinkingLevel']> = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

/**
 * Settings for the LEGACY Pi runtime: file-based auth (auth.json) and model
 * defaults (settings.json). Rendered only when the detected CLI is legacy.
 * This component must never touch current-OMP runtime APIs.
 */
export default function LegacyPiSettings() {
  const { models, modelConfig, loadModelState } = useAppStore()
  const t = useT()
  const [keyInput, setKeyInput] = useState('')
  const [keyState, setKeyState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [keyError, setKeyError] = useState('')
  const [modelSaved, setModelSaved] = useState(false)
  const [catalog, setCatalog] = useState<PiModel[]>([])
  const [machineSkills, setMachineSkillsState] = useState(false)
  const [machineSkillCount, setMachineSkillCount] = useState(0)

  const provider = modelConfig?.defaultProvider ?? ''
  const providerConfigured = provider ? (modelConfig?.authProviders ?? []).includes(provider) : false
  const providerModels = provider ? models.filter((m) => m.provider === provider) : []
  const catalogForProvider = provider ? catalog.filter((m) => m.provider === provider) : []
  const selectableModels = catalogForProvider.length > 0 ? catalogForProvider : providerModels

  useEffect(() => {
    window.electronAPI.listCatalogModels().then(setCatalog)
    window.electronAPI.getStore('machineSkills').then((v) => {
      setMachineSkillsState(v ?? false)
    })
    // Read-only probe for the count — a setMachineSkills() call here would
    // rewrite ~/.pi/agent/settings.json on every view even when nothing changed.
    window.electronAPI.listMachineSkills().then((names) => setMachineSkillCount(names.length))
  }, [])

  const seg = (active: boolean) =>
    `flex h-[26px] items-center rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
      active
        ? 'border-line bg-ink-850 text-cream shadow-card'
        : 'border-transparent text-cream-dim hover:text-cream'
    }`

  const flashModelSaved = () => {
    setModelSaved(true)
    setTimeout(() => setModelSaved(false), 1500)
  }

  const changeProvider = async (id: string) => {
    setKeyInput('')
    setKeyState('idle')
    await window.electronAPI.setModelConfig({ defaultProvider: id, defaultModel: '' })
    loadModelState()
  }

  const changeModel = async (modelId: string) => {
    if (!provider) return
    // Default scope only — a running session keeps its own model.
    await window.electronAPI.setModelConfig({ defaultModel: modelId })
    flashModelSaved()
    loadModelState()
  }

  const saveCustomModel = async (value: string) => {
    if (!provider || value === (modelConfig?.defaultModel ?? '')) return
    await window.electronAPI.setModelConfig({ defaultModel: value })
    flashModelSaved()
    loadModelState()
  }

  const saveKey = async () => {
    if (!provider || !keyInput.trim()) return
    setKeyState('saving')
    const result = await window.electronAPI.setApiKey(provider, keyInput.trim())
    if (result.ok) {
      setKeyInput('')
      setKeyState('saved')
      setTimeout(() => setKeyState('idle'), 2000)
      loadModelState()
    } else {
      setKeyError(result.log)
      setKeyState('error')
    }
  }

  const removeKey = async () => {
    if (!provider) return
    await window.electronAPI.clearApiKey(provider)
    setKeyState('idle')
    loadModelState()
  }

  const changeThinking = async (level: string) => {
    await window.electronAPI.setModelConfig({
      defaultThinkingLevel: level as ModelConfig['defaultThinkingLevel']
    })
    loadModelState()
  }

  const changeTrust = async (value: ModelConfig['projectTrust']) => {
    await window.electronAPI.setModelConfig({ projectTrust: value })
    loadModelState()
  }

  const changeMachineSkills = async (enabled: boolean) => {
    setMachineSkillsState(enabled)
    const r = await window.electronAPI.setMachineSkills(enabled)
    setMachineSkillCount(r.available.length)
  }

  return (
    <>
      <Section title={t('settings.model')}>
        <Row label={t('settings.provider')}>
          <select value={provider} onChange={(e) => changeProvider(e.target.value)} className={selectCls}>
            <option value="">{t('settings.providerAuto')}</option>
            {PI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {(modelConfig?.authProviders ?? []).includes(p.id) ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </Row>
        {provider && (
          <Row label={t('settings.apiKey')}>
            <div className="flex items-center gap-2">
              {providerConfigured && keyState !== 'saved' ? (
                <>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <KeyRound size={11} />
                    {t('settings.providerConfigured')}
                  </span>
                  <button
                    onClick={removeKey}
                    className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim transition-colors hover:border-red-500/40 hover:text-red-500"
                  >
                    {t('settings.clearKey')}
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value)
                      if (keyState === 'error') setKeyState('idle')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveKey()
                    }}
                    placeholder={t('settings.apiKeyPlaceholder')}
                    className={inputCls}
                  />
                  <button onClick={saveKey} disabled={!keyInput.trim() || keyState === 'saving'} className={buttonCls}>
                    {keyState === 'saved' ? (
                      <>
                        <Check size={11} className="text-emerald-500" />
                        {t('settings.saved')}
                      </>
                    ) : keyState === 'saving' ? (
                      t('settings.saving')
                    ) : (
                      t('settings.saveKey')
                    )}
                  </button>
                </>
              )}
            </div>
          </Row>
        )}
        {keyState === 'error' && (
          <Note>
            <span className="text-red-500">{t('settings.saveFailed', { error: keyError })}</span>
          </Note>
        )}
        {provider && (
          <Row label={t('settings.defaultModel')}>
            <div className="flex items-center gap-2">
              {selectableModels.length > 0 ? (
                <select
                  value={modelConfig?.defaultModel ?? ''}
                  onChange={(e) => changeModel(e.target.value)}
                  className={`${selectCls} max-w-64`}
                >
                  <option value="">{t('settings.modelAuto')}</option>
                  {selectableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={provider}
                  defaultValue={modelConfig?.defaultModel ?? ''}
                  onBlur={(e) => saveCustomModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveCustomModel((e.target as HTMLInputElement).value)
                  }}
                  placeholder={t('settings.defaultModelPlaceholder')}
                  className={inputCls}
                />
              )}
              {modelSaved && (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <Check size={11} />
                  {t('settings.saved')}
                </span>
              )}
            </div>
          </Row>
        )}
        <Row label={t('settings.thinking')}>
          <select
            value={modelConfig?.defaultThinkingLevel ?? ''}
            onChange={(e) => changeThinking(e.target.value)}
            className={selectCls}
          >
            <option value="">{t('settings.thinkingDefault')}</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Row>
        <Note>{t('settings.modelNote')}</Note>
      </Section>

      <Section title={t('settings.projectTrust')}>
        <Row label={t('settings.projectTrust')}>
          <div className="flex items-center gap-2">
            <ShieldCheck size={13} className="text-cream-faint" />
            <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
              <button onClick={() => changeTrust('ask')} className={seg((modelConfig?.projectTrust ?? 'ask') === 'ask')}>
                {t('settings.trustAsk')}
              </button>
              <button onClick={() => changeTrust('always')} className={seg((modelConfig?.projectTrust ?? 'ask') === 'always')}>
                {t('settings.trustAlways')}
              </button>
              <button onClick={() => changeTrust('never')} className={seg((modelConfig?.projectTrust ?? 'ask') === 'never')}>
                {t('settings.trustNever')}
              </button>
            </div>
          </div>
        </Row>
        <Note>{t('settings.trustNote')}</Note>
      </Section>

      <Section title={t('settings.skills')}>
        <Row label={t('settings.machineSkills')}>
          <div className="flex rounded-full border border-line bg-ink-800 p-0.5">
            <button onClick={() => changeMachineSkills(true)} className={seg(machineSkills)}>
              {t('settings.on')}
            </button>
            <button onClick={() => changeMachineSkills(false)} className={seg(!machineSkills)}>
              {t('settings.off')}
            </button>
          </div>
        </Row>
        <Note>
          {machineSkillCount > 0
            ? t('settings.machineSkillsNoteCount', { count: machineSkillCount })
            : t('settings.machineSkillsNote')}
        </Note>
      </Section>
    </>
  )
}
