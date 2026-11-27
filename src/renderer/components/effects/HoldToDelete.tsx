import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useT } from '../../i18n'

/**
 * 长按删除按钮（参考 hold-to-delete 效果）：按住后进度环沿按钮边缘走满
 * 才触发 onConfirm；松手 / 移开 / Escape / 失焦按比例回退。键盘 Space/Enter
 * 与指针同一手势；合成点击（detail === 0，读屏/测试路径）直接触发，
 * 后续的确认弹窗与撤销横幅由调用方原有逻辑负责，本组件不替代它们。
 */
const FULL = 100
export const HOLD_TO_DELETE_MS = 1500
const DEFAULT_HOLD_MS = HOLD_TO_DELETE_MS
const RESET_MS = 260

interface HoldToDeleteProps {
  onConfirm: () => void
  /** 动作名，用于组合无障碍名称。 */
  ariaLabel: string
  /** 菜单行文案；纯图标变体省略。 */
  label?: string
  /** 前置图标等内容。 */
  children?: ReactNode
  /** 长按时长，默认 1500ms。 */
  holdMs?: number
  disabled?: boolean
  title?: string
  className?: string
  /** 进度环圆角，菜单行 8、小图标 6。 */
  ringRadius?: number
  /** 转发 data-session-action 等标记（侧栏菜单测试定位用）。 */
  dataSessionAction?: string
}

export default function HoldToDelete({
  onConfirm,
  ariaLabel,
  label,
  children,
  holdMs = DEFAULT_HOLD_MS,
  disabled = false,
  title,
  className = '',
  ringRadius = 8,
  dataSessionAction
}: HoldToDeleteProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const ringRef = useRef<SVGRectElement | null>(null)
  const rafRef = useRef(0)
  const startedAtRef = useRef(0)
  const progressRef = useRef(0)
  const holdingRef = useRef(false)
  const retreatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmRef = useRef(onConfirm)
  const [holding, setHolding] = useState(false)
  const [status, setStatus] = useState<'idle' | 'holding' | 'cancelled'>('idle')
  const t = useT()

  useEffect(() => {
    confirmRef.current = onConfirm
  }, [onConfirm])

  function setRingOffset(offset: number, transitionMs: number | null) {
    const el = ringRef.current
    if (!el) return
    el.style.transition = transitionMs === null ? 'none' : `stroke-dashoffset ${transitionMs}ms linear`
    el.style.strokeDashoffset = String(offset)
  }

  function stopRaf() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }

  function clearRetreatTimer() {
    if (retreatTimerRef.current !== null) {
      clearTimeout(retreatTimerRef.current)
      retreatTimerRef.current = null
    }
  }

  function tick(now: number) {
    if (!holdingRef.current) return
    const progress = Math.min(1, (now - startedAtRef.current) / holdMs)
    progressRef.current = progress
    setRingOffset(FULL * (1 - progress), null)
    if (progress >= 1) {
      finish()
      return
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function start() {
    if (disabled || holdingRef.current) return
    clearRetreatTimer()
    stopRaf()
    holdingRef.current = true
    progressRef.current = 0
    setHolding(true)
    setStatus('holding')
    setRingOffset(FULL, null)
    startedAtRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }

  function finish() {
    stopRaf()
    holdingRef.current = false
    progressRef.current = 0
    setHolding(false)
    setStatus('idle')
    setRingOffset(FULL, null)
    confirmRef.current?.()
  }

  function cancel() {
    if (!holdingRef.current) return
    stopRaf()
    holdingRef.current = false
    setHolding(false)
    setStatus('cancelled')
    const shown = progressRef.current
    progressRef.current = 0
    const retreatMs = Math.round(shown * RESET_MS)
    setRingOffset(FULL, retreatMs)
    clearRetreatTimer()
    retreatTimerRef.current = setTimeout(() => {
      setRingOffset(FULL, null)
      retreatTimerRef.current = null
      setStatus('idle')
    }, retreatMs + 40)
  }

  useEffect(
    () => () => {
      stopRaf()
      clearRetreatTimer()
    },
    []
  )

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    buttonRef.current?.focus({ preventScroll: true })
    start()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (event.key === ' ' || event.key === 'Enter') {
      // 拦下原生激活（阻止 Enter/Space 的默认 click），让键盘也走长按手势。
      event.preventDefault()
      if (event.repeat) return
      start()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      cancel()
    }
  }

  const seconds = (holdMs / 1000).toFixed(1)
  const statusText = status === 'holding' ? t('effects.hold.holding') : status === 'cancelled' ? t('effects.hold.cancelled') : ''
  const accessibleName = disabled ? ariaLabel : t('effects.hold.aria', { action: ariaLabel, seconds })

  return (
    <button
      ref={buttonRef}
      type="button"
      data-holding={holding || undefined}
      data-session-action={dataSessionAction}
      aria-disabled={disabled || undefined}
      aria-label={accessibleName}
      title={title}
      onPointerDown={handlePointerDown}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={cancel}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        // 不冒泡：嵌在可点击卡片里的删除按钮不能顺手选中卡片。
        event.stopPropagation()
        // 合成点击（读屏/测试辅助，detail === 0）直接触发；真实指针点击必须长按。
        if (!disabled && event.detail === 0) {
          stopRaf()
          holdingRef.current = false
          setHolding(false)
          confirmRef.current?.()
        }
      }}
      className={`relative inline-flex select-none items-center gap-1.5 focus-ring ${disabled ? 'cursor-not-allowed' : ''} ${className}`}
    >
      {!disabled && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          // 闲置时整个环隐藏：微红的轨道描边在常驻状态下是视觉噪音，
          // 尤其在小图标按钮上（圆头线帽还会在起点露出一个点）。
          style={{ opacity: holding || status === 'cancelled' ? 1 : 0, transition: 'opacity 150ms linear' }}
        >
          <rect
            x="1"
            y="1"
            width="calc(100% - 2px)"
            height="calc(100% - 2px)"
            rx={ringRadius}
            fill="none"
            stroke="rgb(239 68 68 / 0.16)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <rect
            ref={ringRef}
            x="1"
            y="1"
            width="calc(100% - 2px)"
            height="calc(100% - 2px)"
            rx={ringRadius}
            fill="none"
            stroke="rgb(239 68 68)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            style={{ strokeDashoffset: FULL }}
          />
        </svg>
      )}
      {children}
      {label != null && <span className="truncate">{label}</span>}
      {/* 秒数用伪元素渲染：不进 textContent，外部按文案定位按钮不受影响。 */}
      {label != null && !holding && <span aria-hidden="true" className="hold-seconds ml-auto font-mono text-[10px] tracking-wide opacity-60" data-seconds={seconds} />}
      <span aria-live="polite" className="sr-only">{statusText}</span>
    </button>
  )
}
