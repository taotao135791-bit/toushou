import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, ChevronUp, Check, KeyRound, WandSparkles, Zap } from 'lucide-react'
import { SessionState, SessionThinkingLevel, SessionThinkingSelection, PI_PROVIDERS } from '@shared/types'
import { parseModelSelector } from '@shared/modelSelector'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import { modelSelectorOf } from '../lib/runtimeSnapshot'
import { sessionThinkingOptionsFor } from '../lib/thinking'
import MenuPortal from './MenuPortal'

/** Extract {provider, id, name} from a get_state model object (tolerant). */
function sessionModelOf(state: SessionState | null): { provider: string; id: string; name: string } | null {
  const m = state?.model
  if (!m || typeof m !== 'object') return null
  const o = m as { provider?: unknown; id?: unknown; name?: unknown }
  if (typeof o.id !== 'string' || typeof o.provider !== 'string') return null
  return { provider: o.provider, id: o.id, name: typeof o.name === 'string' ? o.name : o.id }
}

const THUMB = 26

/** All session thinking levels this GUI knows, least to most intensive. */
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

interface ModelThinkingPickerProps {
  /** Live session to read/change; without one the picker sets next-session overrides. */
  sessionId: string | null
  /** Squeezed chat column: trigger collapses to icons (+ tiny level letter). */
  compact?: boolean
}

/**
 * The composer opens the effort panel first. Its model row leads to the
 * model list inside the same popover.
 */
export default function ModelThinkingPicker({ sessionId, compact = false }: ModelThinkingPickerProps) {
  // ----- model state（原 ModelPicker） -----
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
  } = useAppStore(
    useShallow((s) => ({
      models: s.models,
      modelConfig: s.modelConfig,
      loadModelState: s.loadModelState,
      setCurrentSessionModel: s.setCurrentSessionModel,
      runtimeOverview: s.runtimeOverview,
      runtimeModels: s.runtimeModels,
      loadRuntimeModels: s.loadRuntimeModels,
      pendingModel: s.pendingModel,
      setPendingModel: s.setPendingModel
    }))
  )
  const [modelFailed, setModelFailed] = useState(false)

  // ----- thinking state（原 ThinkingPicker） -----
  const [preview, setPreview] = useState<SessionThinkingSelection | null>(null)
  const queued = useRef<{ session: string; level: SessionThinkingSelection }>()
  const writing = useRef(false)
  const dragging = useRef(false)
  const [failedSession, setFailedSession] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ sessionId: string; modelVersion: number; state: SessionState | null }>()
  const [stateRefresh, setStateRefresh] = useState(0)
  const thumbX = useMotionValue(13)
  const trackRef = useRef<HTMLDivElement>(null)
  const trackWidth = useRef(0)
  const eventThinking = useAppStore((s) => (sessionId ? s.sessionThinking[sessionId] : undefined))
  const hasEventThinking = useAppStore((s) => sessionId !== null && sessionId in s.sessionThinking)
  const pendingThinking = useAppStore((s) => s.pendingThinking)
  const setPendingThinking = useAppStore((s) => s.setPendingThinking)
  const setCurrentSessionThinking = useAppStore((s) => s.setCurrentSessionThinking)

  // ----- shared popover -----
  const [open, setOpen] = useState(false)
  const [modelListOpen, setModelListOpen] = useState(false)
  const pickerRef = useRef<HTMLButtonElement>(null)
  const paneFocusRef = useRef<HTMLButtonElement>(null)
  const [switchingModel, setSwitchingModel] = useState(false)

  useLayoutEffect(() => {
    if (open) paneFocusRef.current?.focus({ preventScroll: true })
  }, [open, modelListOpen])
  const t = useT()
  const navigate = useNavigate()
  const overview = useAppStore((s) => s.runtimeOverview)
  const modelVersion = useAppStore((s) => (sessionId ? (s.sessionModelVersion[sessionId] ?? 0) : 0))

  const isCurrent = runtimeOverview?.profile === 'current'
  const thinkingFailed = failedSession !== null && failedSession === sessionId

  // Transient pick-failure hint on the pill (dead session / rejected switch)
  useEffect(() => {
    if (!modelFailed) return
    const timer = setTimeout(() => setModelFailed(false), 2500)
    return () => clearTimeout(timer)
  }, [modelFailed])

  useEffect(() => {
    if (failedSession === null) return
    const timer = setTimeout(() => setFailedSession(null), 2500)
    return () => clearTimeout(timer)
  }, [failedSession])

  useEffect(() => {
    if (isCurrent) {
      void loadRuntimeModels()
    } else if (!modelConfig) {
      void loadModelState()
    }
  }, [isCurrent, modelConfig, loadModelState, loadRuntimeModels])

  // One RPC gets both the current effort and the model's capabilities.
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
  const sessionModel = sessionModelOf(live?.state ?? null)
  const nextModel = parseModelSelector(pendingModel ?? overview?.modelState.defaultModel ?? '')
  const selector = sessionId ? modelSelectorOf(live?.state ?? null) : nextModel?.modelSelector
  const catalogEntry = runtimeModels.find((model) => model.selector === selector)
  const options = sessionThinkingOptionsFor(isCurrent ? 'current' : 'legacy', catalogEntry, live?.state?.modelThinking)
  const level = sessionId
    ? (hasEventThinking ? eventThinking : live?.state?.autoThinking ? 'auto' : live?.state?.thinkingLevel)
    : pendingThinking ?? 'auto'

  const displayLevel = preview ?? level
  const sliderIndex = Math.max(0, options.indexOf(displayLevel as SessionThinkingLevel))
  const position = options.length > 1 ? sliderIndex / (options.length - 1) : 0
  const modelName = catalogEntry?.name ?? selector

  // ----- grouped model list -----
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

  // ----- model label -----
  let modelLabel = t('composer.modelAuto')
  let currentSelector = ''
  if (sessionId) {
    if (sessionModel) {
      modelLabel = sessionModel.name
      currentSelector = `${sessionModel.provider}/${sessionModel.id}`
    }
  } else {
    const def = parseModelSelector(pendingModel ?? '')?.modelSelector
    if (def) {
      modelLabel = items.find((m) => m.selector === def)?.name ?? def
      currentSelector = def
    }
  }

  const pickThinking = async (next: SessionThinkingSelection) => {
    if (!sessionId) {
      setPendingThinking(next)
      setPreview(null)
      return
    }
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
        setStateRefresh((previous) => previous + 1)
      }
    } finally {
      writing.current = false
    }
  }

  const pickModel = async (selector: string) => {
    if (switchingModel) return
    if (sessionId) {
      const slash = selector.indexOf('/')
      if (slash < 1) return
      setSwitchingModel(true)
      const ok = await setCurrentSessionModel(selector.slice(0, slash), selector.slice(slash + 1)).catch(() => false)
      setSwitchingModel(false)
      if (!ok) {
        setModelFailed(true)
        return
      }
      setStateRefresh(previous => previous + 1)
      setModelListOpen(false)
      return
    }
    setModelListOpen(false)
    setPendingModel(selector || null)
  }

  const providerLabel = (id: string) => PI_PROVIDERS.find((p) => p.id === id)?.label ?? id

  // Keep the thumb centered on the selected stop.
  const positionRef = useRef(position)
  positionRef.current = position
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const syncThumb = (springMove: boolean) => {
    const width = trackWidth.current
    if (width <= 0) return
    // 拇指中心 = 填充条右缘：x 为左缘位置，须扣除半个拇指宽。
    const target = (width - THUMB) * positionRef.current
    if (springMove && !reducedMotion()) animate(thumbX, target, { type: 'spring', visualDuration: 0.35, bounce: 0.15 })
    else thumbX.set(target)
  }
  useEffect(() => {
    if (!open || modelListOpen) return
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      trackWidth.current = el.clientWidth
      syncThumb(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelListOpen])
  useEffect(() => {
    syncThumb(!dragging.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position])

  const effortLabel = thinkingFailed ? t('composer.thinkingFailed') : levelLabel(level, t)
  const shownModel = modelFailed ? t('composer.modelFailed') : modelLabel
  const closePicker = () => { setOpen(false); setModelListOpen(false); setPreview(null) }

  return (
    <>
      <button
        ref={pickerRef}
        type="button"
        data-model-thinking-toggle
        data-model-label={shownModel}
        data-effort-label={effortLabel}
        aria-expanded={open}
        aria-controls={open ? 'composer-model-thinking-panel' : undefined}
        aria-label={`${t('composer.model')}: ${shownModel} · ${t('composer.thinking')}: ${effortLabel}`}
        title={t('composer.modelThinking')}
        onClick={() => {
          if (open) closePicker()
          else {
            setOpen(true)
            if (isCurrent) void loadRuntimeModels()
          }
        }}
        className="composer-picker focus-ring inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full py-1 pl-2 pr-1.5 text-[12px] font-medium text-cream-dim hover:bg-overlay hover:text-cream"
      >
        <Zap size={13} aria-hidden="true" className={modelFailed ? 'text-red-500' : ''} />
        {!compact && <span className="max-w-36 truncate">{shownModel}</span>}
        <span className={`whitespace-nowrap ${thinkingFailed ? 'text-red-500' : 'text-cream-faint'}`}>{effortLabel}</span>
        <ChevronUp size={10} aria-hidden="true" className={`composer-picker-chevron shrink-0 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      <MenuPortal open={open} triggerRef={pickerRef} onClose={closePicker} align="end" width={288}>
        <div id="composer-model-thinking-panel">
          {modelListOpen ? (
            <div data-model-list className="px-1.5 py-1">
              <div className="flex items-center gap-2 border-b border-line px-1 pb-1">
                <button ref={paneFocusRef} type="button" aria-label={t('composer.thinking')} onClick={() => setModelListOpen(false)}
                  className="focus-ring rounded-md p-1.5 text-cream-dim hover:bg-overlay"><ArrowLeft size={14} aria-hidden="true" /></button>
                <span className="text-xs font-medium text-cream">{t('composer.chooseModel')}</span>
              </div>
              {modelFailed && <p role="status" className="px-2 py-1 text-xs text-red-500">{t('composer.modelFailed')}</p>}
              <div className="max-h-[min(42vh,290px)] overflow-y-auto py-1">
                {!sessionId && (
                  <button
                    data-model-option=""
                    disabled={switchingModel}
                    onClick={() => void pickModel('')}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay active:scale-[0.98]"
                  >
                    <span>{t('composer.modelAuto')}</span>
                    {!currentSelector && <Check size={12} className="picker-check-pop text-accent" />}
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
                        type="button" data-model-option={m.selector}
                        disabled={switchingModel} aria-pressed={currentSelector === m.selector}
                        onClick={() => void pickModel(m.selector)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-cream transition hover:bg-overlay active:scale-[0.98]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{m.name}</span>
                          <span className="block truncate font-mono text-[10px] text-cream-faint">
                            {m.id}
                          </span>
                        </span>
                        {currentSelector === m.selector && (
                          <Check size={12} className="picker-check-pop shrink-0 text-accent" />
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
              </div>
            </div>
          ) : (
            <div data-thinking-menu data-peak={position === 1} style={{ '--effort-position': position } as CSSProperties} className="px-2.5 py-2">
              <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
                <span data-thinking-level-label className="effort-heading text-sm font-semibold">
                  {levelLabel(displayLevel, t)}
                </span>
                <button ref={paneFocusRef} type="button" data-open-model-list onClick={() => {
                  setModelListOpen(true)
                  if (isCurrent) void loadRuntimeModels()
                  else void loadModelState()
                }} aria-label={t('composer.chooseModel')} title={t('composer.chooseModel')}
                  className="focus-ring flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-cream-dim hover:bg-overlay hover:text-cream">
                  <span className="max-w-36 truncate">{modelName ?? modelLabel}</span>
                  <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
                </button>
              </div>
          <div ref={trackRef} className="effort-track" data-at-start={position === 0}>
            <div aria-hidden="true" className="effort-rail">
              <div className="effort-ticks">{options.map(id => <i key={id} />)}</div>
              <div className="effort-fill"><span aria-hidden="true" className="effort-peak-fill" /><span className="effort-glow" /></div>
            </div>
            <input
              type="range" min={0} max={options.length - 1} step={1} value={sliderIndex}
              disabled={options.length < 2}
              aria-label={t('composer.thinking')} aria-valuetext={t(LEVEL_LABEL[options[sliderIndex]])}
              className="effort-slider"
              onChange={event => setPreview(options[Number(event.currentTarget.value)])}
              onPointerDown={() => { dragging.current = true }}
              onPointerCancel={() => { dragging.current = false; setPreview(null) }}
              onPointerUp={event => { dragging.current = false; void pickThinking(options[Number(event.currentTarget.value)]) }}
              onKeyUp={event => {
                if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'].includes(event.key)) { void pickThinking(options[Number(event.currentTarget.value)]) }
              }}
            />
            <motion.div
              aria-hidden="true"
              className="effort-thumb-live pointer-events-none absolute top-1/2 left-0 z-10 rounded-full"
              style={{
                width: THUMB,
                height: THUMB,
                marginTop: -THUMB / 2,
                background: '#fff',
                border: '1px solid #dedce6',
                boxShadow: '0 1px 3px rgb(24 45 71 / 0.18), 0 0 1px rgb(24 45 71 / 0.18)',
                x: thumbX
              }}
            />
          </div>
          <div className="mt-1 flex items-start justify-between gap-0.5">
            {options.map(id => <button key={id} type="button" data-thinking-choice={id}
              onClick={() => void pickThinking(id)} aria-pressed={displayLevel === id}
              className="focus-ring min-h-6 rounded px-1 text-[10.5px] text-cream-faint transition hover:text-cream active:scale-95 aria-pressed:font-semibold aria-pressed:text-cream">
              {t(LEVEL_LABEL[id])}
            </button>)}
          </div>
          {(isCurrent || !sessionId) && <button
            type="button" data-thinking-choice="auto" aria-pressed={displayLevel === 'auto' || !displayLevel} aria-label={t('composer.thinkingAutoAction')} onClick={() => { if (isCurrent) void pickThinking('auto'); else { setPendingThinking(null); setPreview(null) } }}
            className="focus-ring mt-1 flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-cream-dim hover:bg-overlay"
          ><WandSparkles size={13} />{t('thinking.followModel')}{(!displayLevel || displayLevel === 'auto') && <Check size={13} className="picker-check-pop ml-auto" />}</button>}
            </div>
          )}
        </div>
      </MenuPortal>
    </>
  )
}
