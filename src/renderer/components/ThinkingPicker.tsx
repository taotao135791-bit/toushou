import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronUp } from 'lucide-react'
import { SessionState, SessionThinkingLevel } from '@shared/types'
import { parseModelSelector } from '@shared/modelSelector'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import { modelSelectorOf } from '../lib/runtimeSnapshot'
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
 * breaking the picker. undefined / "auto" means follow the model.
 */
function levelLabel(raw: string | undefined, t: ReturnType<typeof useT>): string {
  if (!raw || raw === 'auto') return t('thinking.followModel')
  if (raw in LEVEL_LABEL) return t(LEVEL_LABEL[raw as SessionThinkingLevel])
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

interface ThinkingPickerProps {
  /** Live session to read/change; without one the picker sets the next-session override. */
  sessionId: string | null
  /** Squeezed chat column: trigger collapses to icon (+ tiny level letter). */
  compact?: boolean
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
export default function ThinkingPicker({ sessionId, compact = false }: ThinkingPickerProps) {
  const [open, setOpen] = useState(false)
  const [failedSession, setFailedSession] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ sessionId: string; modelVersion: number; state: SessionState | null }>()
  const [stateRefresh, setStateRefresh] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const overview = useAppStore((s) => s.runtimeOverview)
  const runtimeModels = useAppStore((s) => s.runtimeModels)
  const modelConfig = useAppStore((s) => s.modelConfig)
  const pendingModel = useAppStore((s) => s.pendingModel)
  const pendingThinking = useAppStore((s) => s.pendingThinking)
  const setPendingThinking = useAppStore((s) => s.setPendingThinking)
  const setCurrentSessionThinking = useAppStore((s) => s.setCurrentSessionThinking)
  const eventLevel = useAppStore((s) => (sessionId ? s.sessionThinking[sessionId] : undefined))
  const hasEventLevel = useAppStore((s) => sessionId !== null && sessionId in s.sessionThinking)
  const modelVersion = useAppStore((s) => (sessionId ? (s.sessionModelVersion[sessionId] ?? 0) : 0))

  const isCurrent = overview?.profile === 'current'
  const failed = failedSession !== null && failedSession === sessionId

  // Transient pick-failure hint on the pill (dead session / rejected switch)
  useEffect(() => {
    if (failedSession === null) return
    const timer = setTimeout(() => setFailedSession(null), 2500)
    return () => clearTimeout(timer)
  }, [failedSession])

  // One RPC gets both the current effort and the model's actual capabilities.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    window.electronAPI.getSessionState(sessionId)
      .catch(() => null)
      .then((state) => {
        if (!cancelled) setSnapshot({ sessionId, modelVersion, state })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, modelVersion, stateRefresh])

  const live = snapshot?.sessionId === sessionId && snapshot.modelVersion === modelVersion ? snapshot : undefined
  const nextModel = parseModelSelector(pendingModel ?? overview?.modelState.defaultModel ?? '')
  const selector = sessionId ? modelSelectorOf(live?.state ?? null) : nextModel?.modelSelector
  const catalogEntry = runtimeModels.find((model) => model.selector === selector)
  const options = sessionThinkingOptionsFor(isCurrent ? 'current' : 'legacy', catalogEntry, live?.state?.modelThinking)
  const defaultThinking = isCurrent
    ? nextModel?.thinkingOverride ?? overview.modelState.defaultThinkingLevel
    : modelConfig?.defaultThinkingLevel
  const level = sessionId
    ? (hasEventLevel ? eventLevel : live?.state?.thinkingLevel)
    : pendingThinking ?? defaultThinking
  const loaded = sessionId ? hasEventLevel || !!live : !!pendingThinking || isCurrent || !!modelConfig

  const pick = async (next: SessionThinkingLevel) => {
    setOpen(false)
    if (sessionId) {
      const ok = await setCurrentSessionThinking(next).catch(() => false)
      if (useAppStore.getState().currentSessionId !== sessionId) return
      if (!ok) {
        setFailedSession(sessionId)
        return
      }
      setFailedSession(null)
      // Legacy sessions do not emit thinking_level_changed.
      if (!isCurrent) setStateRefresh((previous) => previous + 1)
      return
    }
    setPendingThinking(next)
  }

  const isAuto = !level || level === 'auto'

  // Live sessions cannot be switched back to auto (the session enum behind
  // set_thinking_level has no auto), so pre-session this clears the
  // next-session override; in-session it only closes the menu.
  const pickAuto = () => {
    setOpen(false)
    if (sessionId) return
    setPendingThinking(null)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="composer-picker focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
        title={t('composer.thinking')}
        aria-label={`${t('composer.thinking')}: ${
          failed ? t('composer.thinkingFailed') : levelLabel(level, t)
        }`}
      >
        <Brain size={12} className={compact && failed ? 'text-red-500' : ''} />
        {compact ? (
          // Icon-only at squeezed width; the level stays readable as a tiny
          // letter (h/l/m/…), auto/follow-model shows nothing extra.
          level && level !== 'auto' ? (
            <span className="text-[9px] font-semibold uppercase leading-none text-accent">
              {level.charAt(0)}
            </span>
          ) : null
        ) : (
          <span className={failed ? 'text-red-500' : ''}>
            {failed
              ? t('composer.thinkingFailed')
              : `${t('composer.thinking')} · ${loaded ? levelLabel(level, t) : '—'}`}
          </span>
        )}
        {!compact && <ChevronUp size={11} className={`composer-picker-chevron transition ${open ? 'rotate-180' : ''}`} />}
      </button>

      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => setOpen(false)} width={176}>
        <button
          onClick={pickAuto}
          disabled={sessionId !== null && !isAuto}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <span>{t('thinking.followModel')}</span>
          {isAuto && <Check size={12} className="text-accent" />}
        </button>
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
