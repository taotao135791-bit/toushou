"use client"

/**
 * 果冻开关（JellyToggle）——规格固定的微交互组件：
 * 默认（lg）严格按规格：轨道 104×48、滑块 36、行程 56。按住滑块拖动时跟手
 * 并被果冻式拉伸（scaleX 最多 +11px、scaleY 按 0.38 比例压扁），松手后一条
 * 350ms、bounce 0.15 的弹簧按甩动速度或半程位置落位，形变精确回到 1。
 * 位移 ≤3px 视为点击，直接切换且不拉伸。
 * sm 为应用内紧凑行适配的等比小号（公式不变，几何参数缩放）。
 * 所有数值来自下方常量。
 */
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/* ---- 规格（lg 不许四舍五入或“优化”；sm 为等比缩放档） ---- */
const SIZES = {
  lg: { width: 104, height: 48, knob: 36, inset: 6, maxStretch: 11 },
  sm: { width: 40, height: 22, knob: 16, inset: 3, maxStretch: 5 }
} as const

export type JellyToggleSize = keyof typeof SIZES

const STRETCH = 0.38
const DRAG_SLOP = 3
const FLICK_THRESHOLD = 350 // px/s
const RELEASE_BOUNCE = 0.15
const MIN_VISUAL_DURATION = 0.35 // s
const MAX_VELOCITY = 1400 // px/s
// 颜色交叉渐变 220ms 由类名 duration-[220ms] 承载（规格值）。

// The settings use the same neutral surfaces and focus color as the shell.
const TRACK_OFF_BG = 'rgb(var(--accent) / 0.10)'
const TRACK_OFF_BORDER = 'rgb(var(--accent) / 0.17)'
const KNOB_OFF = 'rgb(var(--bg-app))'
const TRACK_ON_BG = 'rgb(var(--accent))'
const TRACK_ON_BORDER = TRACK_ON_BG
const KNOB_ON = KNOB_OFF
const SHADOW_OFF = '0 1px 3px rgb(0 0 0 / 0.17)'
const SHADOW_ON = SHADOW_OFF
const SHADOW_OFF_SM = SHADOW_OFF
const SHADOW_ON_SM = SHADOW_OFF

interface JellyToggleProps {
  /** 受控选中态。 */
  checked?: boolean
  /** 非受控初始态。 */
  defaultChecked?: boolean
  /** 状态切换（含点击与拖动落位）。 */
  onChange?: (checked: boolean) => void
  /** 无障碍名称。 */
  'aria-label'?: string
  /** 规格档：lg=规格原版，sm=紧凑行小号。 */
  size?: JellyToggleSize
  /** 禁用交互：保持可聚焦，仅屏蔽切换并降透明度。 */
  disabled?: boolean
  /** 悬停提示。 */
  title?: string
}

/** 手势现场：起点、滑块起始 x、是否已越过点击阈值、末两次速度采样。 */
interface JellyGesture {
  pointerId: number
  startX: number
  originX: number
  moved: boolean
  maxAbsDx: number
  samples: { time: number; x: number }[]
  startedAt: number
}

export default function JellyToggle({ checked, defaultChecked = false, onChange, 'aria-label': ariaLabel, size = 'lg', disabled = false, title }: JellyToggleProps) {
  const geo = SIZES[size]
  const travel = geo.width - geo.knob - geo.inset * 2
  const controlled = checked !== undefined
  const [internalChecked, setInternalChecked] = useState(defaultChecked)
  const isChecked = controlled ? (checked as boolean) : internalChecked
  const reduced = useReducedMotion()
  const x = useMotionValue(isChecked ? travel : 0)
  const scaleX = useMotionValue(1)
  const scaleY = useMotionValue(1)
  const [originX, setOriginX] = useState<'center' | 'left' | 'right'>('center')
  const gesture = useRef<JellyGesture | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const setChecked = (next: boolean) => {
    if (disabled) return
    if (!controlled) setInternalChecked(next)
    onChange?.(next)
  }

  const settle = (target: boolean, velocity: number) => {
    const current = gesture.current
    gesture.current = null
    const heldMs = current ? performance.now() - current.startedAt : 0
    const clampedVelocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity))
    if (reduced) {
      // ≤1ms 直落终态：不跑弹簧，状态照常更新。
      x.set(target ? travel : 0)
      scaleX.set(1)
      scaleY.set(1)
      setOriginX('center')
      setChecked(target)
      return
    }
    setChecked(target)
    const spring = {
      type: 'spring' as const,
      visualDuration: Math.max(MIN_VISUAL_DURATION, heldMs / 1000),
      bounce: RELEASE_BOUNCE,
      velocity: clampedVelocity
    }
    animate(x, target ? travel : 0, spring)
    animate(scaleX, 1, spring)
    animate(scaleY, 1, spring)
  }

  // 外部（受控）切换时滑块跟随；拖动进行中不抢位。
  useEffect(() => {
    if (gesture.current) return
    const target = isChecked ? travel : 0
    if (reduced || Math.abs(x.get() - target) < 0.5) {
      x.set(target)
      return
    }
    const controls = animate(x, target, { type: 'spring', visualDuration: MIN_VISUAL_DURATION, bounce: RELEASE_BOUNCE })
    return () => controls.stop()
  }, [isChecked, reduced, travel, x])

  // 卸载：停掉所有 animate 控制、释放捕获、清空采样。
  useEffect(() => () => {
    x.stop()
    scaleX.stop()
    scaleY.stop()
    const current = gesture.current
    gesture.current = null
    if (current !== null && buttonRef.current?.hasPointerCapture(current.pointerId)) {
      buttonRef.current.releasePointerCapture(current.pointerId)
    }
  }, [scaleX, scaleY, x])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    event.preventDefault()
    // 回弹中再按：从当前 x 与形变继续，先停掉在跑的弹簧，不排队。
    x.stop()
    scaleX.stop()
    scaleY.stop()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      originX: x.get(),
      moved: false,
      maxAbsDx: 0,
      samples: [{ time: event.timeStamp, x: event.clientX }],
      startedAt: performance.now()
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    const dx = event.clientX - current.startX
    current.maxAbsDx = Math.max(current.maxAbsDx, Math.abs(dx))
    current.samples.push({ time: event.timeStamp, x: event.clientX })
    if (current.samples.length > 2) current.samples.shift()
    if (current.maxAbsDx <= DRAG_SLOP) return
    current.moved = true
    // 跟手 + 果冻拉伸：位移像素封顶，scaleX 放宽 / scaleY 压扁，origin 在拖尾边。
    const nextX = Math.max(0, Math.min(travel, current.originX + dx))
    x.set(nextX)
    if (!reduced) {
      const stretchPixels = Math.min(geo.maxStretch, Math.abs(dx))
      const ratio = stretchPixels / geo.knob
      scaleX.set(1 + ratio)
      scaleY.set(1 - STRETCH * ratio)
      setOriginX(dx > 0 ? 'left' : 'right')
    }
  }

  const endGesture = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancelled) {
      gesture.current = null
      const target = x.get() > travel / 2
      if (reduced) {
        x.set(target ? travel : 0)
        scaleX.set(1)
        scaleY.set(1)
        setOriginX('center')
      } else {
        const spring = { type: 'spring' as const, visualDuration: MIN_VISUAL_DURATION, bounce: RELEASE_BOUNCE }
        animate(x, target ? travel : 0, spring)
        animate(scaleX, 1, spring)
        animate(scaleY, 1, spring)
      }
      return
    }
    if (!current.moved) {
      // 点击：不拉伸，直接切换，滑块用弹簧滑到另一侧。
      settle(!isChecked, sampleVelocity(current.samples))
      return
    }
    // 拖动落位：甩动速度优先，其次半程位置。
    const velocity = sampleVelocity(current.samples)
    const target = Math.abs(velocity) > FLICK_THRESHOLD ? velocity > 0 : x.get() > travel / 2
    settle(target, velocity)
  }

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={isChecked}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event: ReactPointerEvent<HTMLButtonElement>) => endGesture(event, false)}
      onPointerCancel={(event: ReactPointerEvent<HTMLButtonElement>) => endGesture(event, true)}
      onLostPointerCapture={(event: ReactPointerEvent<HTMLButtonElement>) => endGesture(event, true)}
      // 键盘 Space/Enter 触发的 click（detail === 0）；鼠标 click 已在 pointerup 结算，忽略防双切。
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (event.detail !== 0 || disabled) return
        const target = !isChecked
        if (reduced) {
          x.set(target ? travel : 0)
          setChecked(target)
        } else {
          setChecked(target)
          const spring = { type: 'spring' as const, visualDuration: MIN_VISUAL_DURATION, bounce: RELEASE_BOUNCE }
          animate(x, target ? travel : 0, spring)
        }
      }}
      className={`relative inline-block shrink-0 focus-ring [touch-action:pan-y] transition-[background-color,border-color,opacity] duration-[220ms] ${disabled ? 'cursor-default opacity-40' : 'cursor-pointer'}`}
      style={{
        width: geo.width,
        height: geo.height,
        borderRadius: geo.height / 2,
        border: `1px solid ${isChecked ? TRACK_ON_BORDER : TRACK_OFF_BORDER}`,
        backgroundColor: isChecked ? TRACK_ON_BG : TRACK_OFF_BG
      }}
    >
      <motion.div
        style={{
          position: 'absolute',
          top: '50%',
          left: geo.inset,
          width: geo.knob,
          height: geo.knob,
          marginTop: -geo.knob / 2,
          borderRadius: geo.knob / 2,
          x,
          scaleX,
          scaleY,
          transformOrigin: originX,
          backgroundColor: isChecked ? KNOB_ON : KNOB_OFF,
          boxShadow: isChecked ? (size === 'sm' ? SHADOW_ON_SM : SHADOW_ON) : size === 'sm' ? SHADOW_OFF_SM : SHADOW_OFF
        }}
        className="transition-[background-color,box-shadow] duration-[220ms]"
      />
    </motion.button>
  )
}

/** 速度采样：只取末两次 pointermove 的 Δx/Δt（px/s），不累积历史。 */
function sampleVelocity(samples: { time: number; x: number }[]): number {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dt = last.time - first.time
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0
}
