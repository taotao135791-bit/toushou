import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronUp } from 'lucide-react'
import { SessionState, SessionThinkingLevel } from '@shared/types'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import { sessionThinkingOptionsFor } from '../lib/thinking'
import MenuPortal from './MenuPortal'

/** All session levels this GUI knows, least to most intensive. */
const LEVEL_LABEL: Record<SessionThinkingLevel, I18nKey> = {
  off: 'composer.thinkingOff',
  minimal: 'composer.thinkingMinimal',
  low: 'composer.thinkingLow',
  medium: 'composer.thinkingMedium',
  high: 'composer.thinkingHigh',
  xhigh: 'composer.thinkingXhigh',
  max: 'composer.thinkingMax'
}

/**
 * Display a runtime-reported level. Known values render via i18n; unknown
 * future levels (e.g. a new "ultra") still render readably instead of
 * breaking the picker. undefined means the runtime's "auto".
 */
function levelLabel(raw: string | undefined, t: ReturnType<typeof useT>): string {
  if (!raw) return t('composer.thinkingAuto')
  if (raw in LEVEL_LABEL) return t(LEVEL_LABEL[raw as SessionThinkingLevel])
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** Extract the current session's model selector from get_state (tolerant). */
function modelSelectorOf(state: SessionState | null): string {
  const m = state?.model
  if (!m || typeof m !== 'object') return ''
  const o = m as { provider?: unknown; id?: unknown }
  if (typeof o.provider !== 'string' || typeof o.id !== 'string') return ''
  return `${o.provider}/${o.id}`
}

interface ThinkingPickerProps {
  /** Live session to read/change; without one the picker sets the next-session override. */
  sessionId: string | null
}

/**
 * Thinking-level dropdown next to the model picker. Scope mirrors the model
 * picker exactly: WITH a session it switches exactly that session
 * (`set_thinking_level`); WITHOUT one it sets a one-shot next-session
 * override. Neither path touches the runtime default (Settings owns that).
 *
 * Options are the SESSION enum (off..max) filtered by the current model's
 * capability list. This is intentionally a different enum from the config
 * `defaultThinkingLevel` (`auto`, no `off`) — never the two shall mix.
 */
export default function ThinkingPicker({ sessionId }: ThinkingPickerProps) {
  const [level, setLevel] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sessionSelector, setSessionSelector] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const overview = useAppStore((s) => s.runtimeOverview)
  const runtimeModels = useAppStore((s) => s.runtimeModels)
  const pendingThinking = useAppStore((s) => s.pendingThinking)
  const setPendingThinking = useAppStore((s) => s.setPendingThinking)
  const setCurrentSessionThinking = useAppStore((s) => s.setCurrentSessionThinking)
  const eventLevel = useAppStore((s) => (sessionId ? s.sessionThinking[sessionId] : undefined))
  const hasEventLevel = useAppStore((s) => sessionId !== null && sessionId in s.sessionThinking)
  const modelVersion = useAppStore((s) => (sessionId ? (s.sessionModelVersion[sessionId] ?? 0) : 0))

  const isCurrent = overview?.profile === 'current'

  // Transient pick-failure hint on the pill (dead session / rejected switch)
  useEffect(() => {
    if (!failed) return
    const timer = setTimeout(() => setFailed(false), 2500)
    return () => clearTimeout(timer)
  }, [failed])

  // The session's model — the capability filter for the offered levels.
  useEffect(() => {
    if (!sessionId) {
      setSessionSelector('')
      return
    }
    let cancelled = false
    window.electronAPI.getSessionState(sessionId).then((state) => {
      if (!cancelled) setSessionSelector(modelSelectorOf(state))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, modelVersion])

  // Sync the current level: event-resolved first, then probes/defaults.
  useEffect(() => {
    if (hasEventLevel) {
      setLevel(eventLevel)
      setLoaded(true)
      return
    }
    setLoaded(false)
    if (sessionId) {
      let cancelled = false
      window.electronAPI.getSessionState(sessionId).then((state) => {
        if (!cancelled) {
          setLevel(state?.thinkingLevel ?? undefined)
          setLoaded(true)
        }
      })
      return () => {
        cancelled = true
      }
    }
    // No session: the next-session override, else the runtime default.
    setLevel(pendingThinking ?? (isCurrent ? overview?.modelState.defaultThinkingLevel || undefined : undefined))
    if (!isCurrent) {
      let cancelled = false
      window.electronAPI.getModelConfig().then((cfg) => {
        if (!cancelled) {
          setLevel(pendingThinking ?? (cfg.defaultThinkingLevel || undefined))
          setLoaded(true)
        }
      })
      return () => {
        cancelled = true
      }
    }
    setLoaded(true)
  }, [sessionId, hasEventLevel, eventLevel, pendingThinking, isCurrent, overview?.modelState.defaultThinkingLevel])

  // Offered levels: the model's own capability set when known.
  const catalogEntry = runtimeModels.find((m) => m.selector === sessionSelector)
  const options = sessionThinkingOptionsFor(isCurrent ? 'current' : 'legacy', catalogEntry)

  const pick = async (next: SessionThinkingLevel) => {
    setOpen(false)
    if (sessionId) {
      // Session scope only; display follows the runtime-resolved event. The
      // legacy path has no event, so it applies the level locally — but only
      // when the switch actually landed (never leave a lie on the pill).
      const ok = await setCurrentSessionThinking(next)
      if (!ok) {
        setFailed(true)
        return
      }
      if (!isCurrent) setLevel(next)
      return
    }
    setPendingThinking(next)
    setLevel(next)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-all hover:border-ink-600 hover:text-cream"
        title={t('composer.thinking')}
      >
        <Brain size={12} />
        <span className={failed ? 'text-red-500' : ''}>
          {failed
            ? t('composer.thinkingFailed')
            : `${t('composer.thinking')} · ${loaded ? levelLabel(level, t) : '—'}`}
        </span>
        <ChevronUp size={11} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => setOpen(false)} width={128}>
        {options.map((id) => (
          <button
            key={id}
            onClick={() => pick(id)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay"
          >
            <span>{t(LEVEL_LABEL[id])}</span>
            {level === id && <Check size={12} className="text-accent" />}
          </button>
        ))}
      </MenuPortal>
    </div>
  )
}