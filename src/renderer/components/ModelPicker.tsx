import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronUp, Cpu, KeyRound } from 'lucide-react'
import { PI_PROVIDERS, SessionState } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import MenuPortal from './MenuPortal'

/** Extract {provider, id, name} from a get_state model object (tolerant). */
function sessionModelOf(state: SessionState | null): { provider: string; id: string; name: string } | null {
  const m = state?.model
  if (!m || typeof m !== 'object') return null
  const o = m as { provider?: unknown; id?: unknown; name?: unknown }
  if (typeof o.id !== 'string' || typeof o.provider !== 'string') return null
  return { provider: o.provider, id: o.id, name: typeof o.name === 'string' ? o.name : o.id }
}

interface ModelPickerProps {
  /** Live session whose model display/hot-switch applies; null = next-session override. */
  sessionId: string | null
}

/**
 * Codex-style model picker in the composer. Scope is strict:
 * - WITH a session: switches exactly that session (set_model) — the default
 *   for future sessions is untouched.
 * - WITHOUT one: sets a one-shot override consumed by the next session's
 *   spawn args — again never the runtime default (that lives in Settings).
 *
 * The list is whatever the runtime can actually run right now
 * (credential-filtered by the runtime itself).
 */
export default function ModelPicker({ sessionId }: ModelPickerProps) {
  const {
    models,
    modelConfig,
    loadModelState,
    setCurrentSessionModel,
    runtimeOverview,
    runtimeModels,
    loadRuntimeModels,
    pendingModel,
    setPendingModel
  } = useAppStore()
  const [open, setOpen] = useState(false)
  const [sessionModel, setSessionModel] = useState<{ provider: string; id: string; name: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const t = useT()
  const modelVersion = useAppStore((s) => (sessionId ? (s.sessionModelVersion[sessionId] ?? 0) : 0))

  const isCurrent = runtimeOverview?.profile === 'current'

  // Transient pick-failure hint on the pill (dead session / rejected switch)
  useEffect(() => {
    if (!failed) return
    const timer = setTimeout(() => setFailed(false), 2500)
    return () => clearTimeout(timer)
  }, [failed])

  useEffect(() => {
    if (isCurrent) {
      void loadRuntimeModels()
    } else if (!modelConfig) {
      void loadModelState()
    }
  }, [isCurrent, modelConfig, loadModelState, loadRuntimeModels])

  // The live session's actual model, straight from the runtime (get_state).
  useEffect(() => {
    if (!sessionId) {
      setSessionModel(null)
      return
    }
    let cancelled = false
    window.electronAPI.getSessionState(sessionId).then((state) => {
      if (!cancelled) setSessionModel(sessionModelOf(state))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, modelVersion])

  const providerLabel = (id: string) => PI_PROVIDERS.find((p) => p.id === id)?.label ?? id

  // ----- grouped list -------------------------------------------------------
  type Item = { provider: string; id: string; selector: string; name: string }
  const items: Item[] = isCurrent
    ? runtimeModels.map((m) => ({ provider: m.provider, id: m.id, selector: m.selector, name: m.name }))
    : models.map((m) => ({ provider: m.provider, id: m.id, selector: `${m.provider}/${m.id}`, name: m.name }))
  const groups = items.reduce<Map<string, Item[]>>((acc, m) => {
    const list = acc.get(m.provider) ?? []
    list.push(m)
    acc.set(m.provider, list)
    return acc
  }, new Map())

  // ----- current selection label -------------------------------------------
  let label = t('composer.modelAuto')
  let currentSelector = ''
  if (sessionId) {
    if (sessionModel) {
      label = sessionModel.name
      currentSelector = `${sessionModel.provider}/${sessionModel.id}`
    }
  } else {
    // No session: the next-session override, else the runtime default.
    const def = isCurrent
      ? pendingModel || (runtimeOverview?.modelState.defaultModel ?? '')
      : pendingModel || (modelConfig?.defaultProvider && modelConfig?.defaultModel
          ? `${modelConfig.defaultProvider}/${modelConfig.defaultModel}`
          : '')
    if (def) {
      label = items.find((m) => m.selector === def)?.name ?? def
      currentSelector = def
    }
  }

  const pick = async (selector: string) => {
    setOpen(false)
    if (sessionId) {
      if (!selector) return // a live session has no "auto" to return to
      const slash = selector.indexOf('/')
      const ok = await setCurrentSessionModel(selector.slice(0, slash), selector.slice(slash + 1))
      // Nothing is optimistic here (the label rides get_state), so a rejected
      // switch only needs the transient failure hint.
      if (!ok) setFailed(true)
      return
    }
    // No session: next-session override ('' clears it back to the default).
    setPendingModel(selector || null)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen((v) => !v)
          if (!open) {
            if (isCurrent) void loadRuntimeModels()
            else void loadModelState()
          }
        }}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-all hover:border-ink-600 hover:text-cream"
        title={sessionId ? t('composer.model') : t('composer.modelNextSession')}
      >
        <Cpu size={12} />
        <span className={`max-w-36 truncate ${failed ? 'text-red-500' : ''}`}>
          {failed ? t('composer.modelFailed') : label}
        </span>
        <ChevronUp size={11} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => setOpen(false)} width={256} maxHeight={320}>
        {!sessionId && (
          <button
            onClick={() => pick('')}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
          >
            <span>{t('composer.modelAuto')}</span>
            {!currentSelector && <Check size={12} className="text-accent" />}
          </button>
        )}

        {Array.from(groups.entries()).map(([pid, list]) => (
          <div key={pid} className="mt-1">
            <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-cream-faint">
              {providerLabel(pid)}
            </div>
            {list.map((m) => (
              <button
                key={m.selector}
                onClick={() => pick(m.selector)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
              >
                <span className="min-w-0">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate font-mono text-[10px] text-cream-faint">
                    {m.id}
                  </span>
                </span>
                {currentSelector === m.selector && (
                  <Check size={12} className="shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        ))}

        {items.length === 0 && (
          <button
            onClick={() => {
              setOpen(false)
              navigate('/settings')
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream-dim transition hover:bg-overlay hover:text-cream"
          >
            <KeyRound size={12} />
            {t('composer.noModels')}
          </button>
        )}
      </MenuPortal>
    </div>
  )
}
