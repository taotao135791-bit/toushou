import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Brain, ChevronUp, Check, WandSparkles, Zap } from 'lucide-react'
import { SessionState, SessionThinkingLevel, SessionThinkingSelection } from '@shared/types'
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
 * The slider uses the model's concrete capabilities. Current OMP also
 * accepts an explicit automatic selection independently of those levels.
 */
export default function ThinkingPicker({ sessionId, compact = false }: ThinkingPickerProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<SessionThinkingSelection | null>(null)
  const queued = useRef<{ session: string; level: SessionThinkingSelection }>()
  const writing = useRef(false)
  const dragging = useRef(false)
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
    ? (hasEventLevel ? eventLevel : live?.state?.autoThinking ? 'auto' : live?.state?.thinkingLevel)
    : pendingThinking ?? defaultThinking
  const loaded = sessionId ? hasEventLevel || !!live : !!pendingThinking || isCurrent || !!modelConfig

  const pick = async (next: SessionThinkingSelection) => {
    if (!sessionId) {
      setPendingThinking(next)
      setPreview(null)
      return
    }
    // Serialize writes and coalesce rapid changes while the runtime confirms one.
    setPreview(next)
    queued.current = { session: sessionId, level: next }
    if (writing.current) return
    writing.current = true
    try {
      while (queued.current) {
        const request = queued.current
        queued.current = undefined
        if (useAppStore.getState().currentSessionId !== request.session) continue
        const ok = await setCurrentSessionThinking(request.level).catch(() => false)
        if (queued.current || useAppStore.getState().currentSessionId !== request.session) continue
        setFailedSession(ok ? null : request.session)
        if (!dragging.current) setPreview(null)
        setStateRefresh(previous => previous + 1)
      }
    } finally {
      writing.current = false
    }
  }

  const displayLevel = preview ?? level
  const sliderIndex = Math.max(0, options.indexOf(displayLevel as SessionThinkingLevel))

  const position = options.length > 1 ? sliderIndex / (options.length - 1) : 0
  const modelName = catalogEntry?.name ?? selector
  return (
    <div className="flex items-center">
      <button
        type="button" ref={triggerRef}
        onClick={() => { setPreview(null); setOpen(value => !value) }}
        className="composer-picker focus-ring inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-cream-dim hover:bg-overlay disabled:opacity-50"
        title={t('composer.thinking')}
        aria-expanded={open}
        aria-label={`${t('composer.thinking')}: ${failed ? t('composer.thinkingFailed') : levelLabel(level, t)}`}
      >
        {compact && <Brain size={13} />}
        <span className={failed ? 'text-red-500' : ''}>{failed ? t('composer.thinkingFailed') : loaded ? levelLabel(level, t) : '—'}</span>
        {!compact && <ChevronUp size={10} className={`composer-picker-chevron transition ${open ? 'rotate-180' : ''}`} />}
      </button>
      <MenuPortal open={open} triggerRef={triggerRef} onClose={() => { setOpen(false); setPreview(null) }} align="end" width={282}>
        <div data-thinking-menu data-peak={position === 1} className="px-2.5 py-2">
          <div className="relative mb-3 flex min-h-8 flex-col items-center justify-center px-6">
            <Zap size={15} aria-hidden="true" className="effort-bolt absolute left-0 top-1" />
            <strong className="effort-heading text-sm font-semibold">{levelLabel(displayLevel, t)}</strong>
            {modelName && <span title={modelName} className="max-w-full truncate text-xs text-cream-faint">{modelName}</span>}
          </div>
          <div className="effort-track" data-at-start={position === 0} style={{ '--effort-position': position } as CSSProperties}>
            <div aria-hidden="true" className="effort-rail">
              <div className="effort-ticks">{options.map(id => <i key={id} />)}</div>
              <div className="effort-fill"><span className="effort-glow" /></div>
            </div>
            <input
              type="range" min={0} max={options.length - 1} step={1} value={sliderIndex}
              disabled={options.length < 2}
              aria-label={t('composer.thinking')} aria-valuetext={t(LEVEL_LABEL[options[sliderIndex]])}
              className="effort-slider focus-ring"
              onChange={event => setPreview(options[Number(event.currentTarget.value)])}
              onPointerDown={() => { dragging.current = true }}
              onPointerCancel={() => { dragging.current = false; setPreview(null) }}
              onPointerUp={event => { dragging.current = false; void pick(options[Number(event.currentTarget.value)]) }}
              onKeyUp={event => {
                if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'].includes(event.key)) void pick(options[Number(event.currentTarget.value)])
              }}
            />
          </div>
          <div className="mt-1 flex items-start justify-between gap-0.5">
            {options.map(id => <button key={id} type="button" data-thinking-choice={id}
              onClick={() => void pick(id)} aria-pressed={displayLevel === id}
              className="focus-ring min-h-6 rounded px-1 text-[10.5px] text-cream-faint hover:text-cream aria-pressed:font-semibold aria-pressed:text-cream">
              {t(LEVEL_LABEL[id])}
            </button>)}
          </div>
          {(isCurrent || !sessionId) && <button
            type="button" data-thinking-choice="auto" aria-pressed={loaded && (displayLevel === 'auto' || !displayLevel)} aria-label={t('composer.thinkingAutoAction')} onClick={() => { if (isCurrent) void pick('auto'); else { setPendingThinking(null); setPreview(null) } }}
            className="focus-ring mt-1 flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-cream-dim hover:bg-overlay"
          ><WandSparkles size={13} />{t('thinking.followModel')}{loaded && (!displayLevel || displayLevel === 'auto') && <Check size={13} className="ml-auto" />}</button>}
        </div>
      </MenuPortal>
    </div>
  )
}
