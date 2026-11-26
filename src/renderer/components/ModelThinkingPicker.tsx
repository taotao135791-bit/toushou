import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { Brain, ChevronRight, ChevronUp, Check, KeyRound, WandSparkles, Zap } from 'lucide-react'
import { SessionState, SessionThinkingLevel, SessionThinkingSelection, PI_PROVIDERS } from '@shared/types'
import { parseModelSelector } from '@shared/modelSelector'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import { modelSelectorOf } from '../lib/runtimeSnapshot'
import { sessionThinkingOptionsFor } from '../lib/thinking'
import { useJellyStretch } from './effects/useJellyStretch'
import MenuPortal from './MenuPortal'

/** Extract {provider, id, name} from a get_state model object (tolerant). */
function sessionModelOf(state: SessionState | null): { provider: string; id: string; name: string } | null {
  const m = state?.model
  if (!m || typeof m !== 'object') return null
  const o = m as { provider?: unknown; id?: unknown; name?: unknown }
  if (typeof o.id !== 'string' || typeof o.provider !== 'string') return null
  return { provider: o.provider, id: o.id, name: typeof o.name === 'string' ? o.name : o.id }
}

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
 * 合并调整器（GPT 式）：模型列表与思考强度在同一个弹窗里，一次打开同时可换
 * 模型、调强度。弹窗外保留两颗入口药丸（显示方式不变），点任意一颗都打开
 * 同一个弹窗；模型药丸是锚点。作用域规则与拆分前一致：
 * - 有会话：只改该会话（set_model / set_thinking_level），不碰运行时默认。
 * - 无会话：一次性下一会话覆盖（pendingModel / pendingThinking）。
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
  const [sessionModel, setSessionModel] = useState<{ provider: string; id: string; name: string } | null>(null)
  const [modelFailed, setModelFailed] = useState(false)

  // ----- thinking state（原 ThinkingPicker） -----
  const [preview, setPreview] = useState<SessionThinkingSelection | null>(null)
  const queued = useRef<{ session: string; level: SessionThinkingSelection }>()
  const writing = useRef(false)
  const dragging = useRef(false)
  const [dragHint, setDragHint] = useState(false)
  const [burst, setBurst] = useState(0)
  const [failedSession, setFailedSession] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ sessionId: string; modelVersion: number; state: SessionState | null }>()
  const [stateRefresh, setStateRefresh] = useState(0)
  const jelly = useJellyStretch({ knobSize: 26, maxStretch: 8 })
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
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null)
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
  const nextModel = parseModelSelector(pendingModel ?? overview?.modelState.defaultModel ?? '')
  const selector = sessionId ? modelSelectorOf(live?.state ?? null) : nextModel?.modelSelector
  const catalogEntry = runtimeModels.find((model) => model.selector === selector)
  const options = sessionThinkingOptionsFor(isCurrent ? 'current' : 'legacy', catalogEntry, live?.state?.modelThinking)
  const defaultThinking = isCurrent
    ? nextModel?.thinkingOverride ?? overview?.modelState.defaultThinkingLevel
    : modelConfig?.defaultThinkingLevel
  const level = sessionId
    ? (hasEventThinking ? eventThinking : live?.state?.autoThinking ? 'auto' : live?.state?.thinkingLevel)
    : pendingThinking ?? defaultThinking
  const loaded = sessionId ? hasEventThinking || !!live : !!pendingThinking || isCurrent || !!modelConfig

  const displayLevel = preview ?? level
  const sliderIndex = Math.max(0, options.indexOf(displayLevel as SessionThinkingLevel))
  const position = options.length > 1 ? sliderIndex / (options.length - 1) : 0
  const heavy = displayLevel === 'high' || displayLevel === 'xhigh' || displayLevel === 'max'
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
    const def = isCurrent
      ? parseModelSelector(pendingModel || runtimeOverview?.modelState.defaultModel || '')?.modelSelector
      : pendingModel || (modelConfig?.defaultProvider && modelConfig?.defaultModel
          ? `${modelConfig.defaultProvider}/${modelConfig.defaultModel}`
          : '')
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
    setModelListOpen(false)
    if (sessionId) {
      if (!selector) return // a live session has no "auto" to return to
      const slash = selector.indexOf('/')
      const ok = await setCurrentSessionModel(selector.slice(0, slash), selector.slice(slash + 1))
      if (!ok) setModelFailed(true)
      return
    }
    setPendingModel(selector || null)
  }

  const providerLabel = (id: string) => PI_PROVIDERS.find((p) => p.id === id)?.label ?? id

  // ----- effort thumb (jelly) sync -----
  const positionRef = useRef(position)
  positionRef.current = position
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const syncThumb = (springMove: boolean) => {
    const width = trackWidth.current
    if (width <= 0) return
    // 拇指中心 = 填充条右缘：x 为左缘位置，须扣除半个拇指宽。
    const target = (width - 26) * positionRef.current
    if (springMove && !reducedMotion()) animate(thumbX, target, { type: 'spring', visualDuration: 0.35, bounce: 0.15 })
    else thumbX.set(target)
  }
  useEffect(() => {
    if (!open) return
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      trackWidth.current = el.clientWidth
      syncThumb(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    syncThumb(!dragging.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position])

  return (
    <div className="flex items-center">
      <button
        ref={modelTriggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`${t('composer.model')}: ${modelFailed ? t('composer.modelFailed') : modelLabel}`}
        title={sessionId ? t('composer.model') : t('composer.modelNextSession')}
        onClick={() => {
          if (!open) {
            if (isCurrent) void loadRuntimeModels()
            else void loadModelState()
          }
          setOpen((v) => !v)
        }}
        className="composer-picker focus-ring flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-medium whitespace-nowrap text-cream-dim transition-colors hover:bg-overlay hover:text-cream"
      >
        <Zap size={13} className={compact && modelFailed ? 'text-red-500' : ''} />
        {!compact && (
          <span key={modelFailed ? 'failed' : modelLabel} className="picker-label-pop max-w-36 truncate">
            <span className={modelFailed ? 'text-red-500' : ''}>
              {modelFailed ? t('composer.modelFailed') : modelLabel}
            </span>
          </span>
        )}
      </button>
      <button
        ref={thinkingTriggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`${t('composer.thinking')}: ${thinkingFailed ? t('composer.thinkingFailed') : levelLabel(level, t)}`}
        title={t('composer.thinking')}
        onClick={() => setOpen((v) => !v)}
        className="composer-picker focus-ring inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-cream-dim hover:bg-overlay disabled:opacity-50"
      >
        {compact && <Brain size={13} />}
        <span key={thinkingFailed ? 'failed' : String(level)} className="picker-label-pop">
          <span className={thinkingFailed ? 'text-red-500' : ''}>{thinkingFailed ? t('composer.thinkingFailed') : loaded ? levelLabel(level, t) : '—'}</span>
        </span>
        {!compact && <ChevronUp size={10} className={`composer-picker-chevron transition ${open ? 'rotate-180' : ''}`} />}
      </button>
      <MenuPortal open={open} triggerRef={modelTriggerRef} onClose={() => { setOpen(false); setPreview(null) }} align="start" width={288}>
        <div data-thinking-menu data-peak={position === 1} style={{ '--effort-position': position } as CSSProperties} className="px-2.5 py-2">
          {/* ---- 模型区：当前模型行 + 箭头展开二级列表（GPT 式，不平铺） ---- */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (!open) { /* noop */ }
              setModelListOpen((v) => !v)
              if (!modelListOpen && isCurrent) void loadRuntimeModels()
            }}
            aria-expanded={modelListOpen}
            className="focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-overlay"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Zap size={13} className="shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate text-[13px] font-medium text-cream">{modelLabel}</span>
            </span>
            <ChevronRight size={13} className={`shrink-0 text-cream-faint transition-transform duration-200 ${modelListOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
          <div
            className="grid transition-[grid-template-rows] duration-200 [transition-timing-function:var(--ease-out)]"
            style={{ gridTemplateRows: modelListOpen ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              <div className="pb-1">
                {!sessionId && (
                  <button
                    onClick={() => pickModel('')}
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
                        onClick={() => pickModel(m.selector)}
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
          </div>

          <div className="my-2 border-t border-line" />

          {/* ---- 思考强度区 ---- */}
          <div className="relative mb-3 flex min-h-8 flex-col items-center justify-center px-6">
            <Zap size={15} aria-hidden="true" className="effort-bolt absolute left-0 top-1" />
            {/* While dragging, swap the value for a per-band hint (ChatGPT-style); the key swap pops. */}
            <strong key={dragHint ? 'hint' : String(displayLevel)} className="effort-heading picker-label-pop text-sm font-semibold">
              {dragHint ? t(heavy ? 'composer.thinkingHintHeavy' : 'composer.thinkingHintLight') : levelLabel(displayLevel, t)}
            </strong>
            {modelName && <span title={modelName} className="max-w-full truncate text-xs text-cream-faint">{modelName}</span>}
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
              onPointerDown={event => { dragging.current = true; setDragHint(true); setBurst(value => value + 1); jelly.handlers.onPointerDown(event) }}
              onPointerMove={jelly.handlers.onPointerMove}
              onPointerCancel={event => { dragging.current = false; setDragHint(false); setPreview(null); jelly.handlers.onPointerCancel(event) }}
              onPointerUp={event => { dragging.current = false; setDragHint(false); setBurst(value => value + 1); jelly.handlers.onPointerUp(event); void pickThinking(options[Number(event.currentTarget.value)]) }}
              onKeyUp={event => {
                if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'].includes(event.key)) { setBurst(value => value + 1); void pickThinking(options[Number(event.currentTarget.value)]) }
              }}
            />
            {burst > 0 && <span key={burst} aria-hidden="true" className="effort-burst" />}
            <motion.div
              aria-hidden="true"
              className="effort-thumb-live pointer-events-none absolute top-1/2 left-0 z-10 rounded-full"
              style={{
                width: 26,
                height: 26,
                marginTop: -13,
                background: '#fff',
                border: '1px solid #dedce6',
                boxShadow: '0 1px 3px rgb(24 45 71 / 0.18), 0 0 1px rgb(24 45 71 / 0.18)',
                x: thumbX,
                scaleX: jelly.scaleX,
                scaleY: jelly.scaleY,
                transformOrigin: jelly.origin
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
            type="button" data-thinking-choice="auto" aria-pressed={loaded && (displayLevel === 'auto' || !displayLevel)} aria-label={t('composer.thinkingAutoAction')} onClick={() => { if (isCurrent) void pickThinking('auto'); else { setPendingThinking(null); setPreview(null) } }}
            className="focus-ring mt-1 flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-cream-dim hover:bg-overlay"
          ><WandSparkles size={13} />{t('thinking.followModel')}{loaded && (!displayLevel || displayLevel === 'auto') && <Check size={13} className="picker-check-pop ml-auto" />}</button>}
        </div>
      </MenuPortal>
    </div>
  )
}
