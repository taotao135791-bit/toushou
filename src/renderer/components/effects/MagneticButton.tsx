"use client"

/**
 * 磁吸按钮：指针进入按钮周围磁场时，按钮被轻微吸向指针（越近吸力越强，
 * falloff 曲线），离开磁场弹簧归位；悬停微放大、glow 开启时有一层跟随
 * 指针的光晕、文字按 labelFollow 比例轻微跟随。触摸设备不吸附（按下微缩）。
 * 磁场用全局 pointermove + 距离计算感知，不占布局、不遮挡相邻控件。
 */
import { animate, motion, useMotionTemplate, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

/* 量级沿用效果库默认值，按 36px 圆钮调校。 */
const FALLBACK = { radius: 72, pull: 8, stiffness: 220, damping: 24, scale: 1.04 }
const FALLOFF = 1.5
const MASS = 0.7
const LABEL_FOLLOW = 0.3
const HOVER_SPRING = { stiffness: 360, damping: 26, mass: MASS }
const GLOW_DIAMETER = 110
const TOUCH_SCALE = 0.97

interface MagneticButtonProps {
  children: ReactNode
  onClick?: () => void
  className?: string
  title?: string
  'aria-label'?: string
  /** 禁用交互：不吸附、不发光、不响应点击，样式仍由 className 负责。 */
  disabled?: boolean
  /** 磁场半径（px）。 */
  radius?: number
  /** 最大吸附位移（px）。 */
  pull?: number
  /** 悬停放大倍数。 */
  scale?: number
  /** 指针跟随光晕层。 */
  glow?: boolean
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export default function MagneticButton({
  children,
  onClick,
  className,
  title,
  'aria-label': ariaLabel,
  disabled = false,
  radius = FALLBACK.radius,
  pull = FALLBACK.pull,
  scale = FALLBACK.scale,
  glow = true
}: MagneticButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const engaged = useRef(false)
  const reduced = useReducedMotion()

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const hoverScale = useMotionValue(1)
  const glowX = useMotionValue(50)
  const glowY = useMotionValue(50)
  const glowOpacity = useMotionValue(0)
  const labelX = useTransform(x, (value) => value * LABEL_FOLLOW)
  const labelY = useTransform(y, (value) => value * LABEL_FOLLOW)
  const glowBackground = useMotionTemplate`radial-gradient(${GLOW_DIAMETER}px circle at ${glowX}% ${glowY}%, rgb(var(--accent) / 0.18), transparent 65%)`

  const spring = useMemo(() => ({ type: 'spring' as const, stiffness: FALLBACK.stiffness, damping: FALLBACK.damping, mass: MASS }), [])
  const release = useCallback(() => {
    if (!engaged.current) return
    engaged.current = false
    animate(x, 0, spring)
    animate(y, 0, spring)
    animate(glowOpacity, 0, HOVER_SPRING)
  }, [glowOpacity, spring, x, y])

  // 磁场感知：全局指针移动 + 距离计算，不占用布局空间也不遮挡相邻控件。
  useEffect(() => {
    if (reduced || disabled) return
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons !== 0) return
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const dx = event.clientX - (rect.left + rect.width / 2)
      const dy = event.clientY - (rect.top + rect.height / 2)
      const distance = Math.hypot(dx, dy)
      if (distance > radius) {
        release()
        return
      }
      engaged.current = true
      const strength = Math.pow(1 - Math.min(distance / radius, 1), FALLOFF)
      const safeDistance = distance || 1
      animate(x, (dx / safeDistance) * strength * pull, spring)
      animate(y, (dy / safeDistance) * strength * pull, spring)
      if (glow) animate(glowOpacity, 1, HOVER_SPRING)
      glowX.set(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100))
      glowY.set(clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('blur', release)
      x.stop()
      y.stop()
      glowOpacity.stop()
      engaged.current = false
    }
  }, [disabled, glow, glowOpacity, glowX, glowY, pull, radius, reduced, release, spring, x, y])

  const onButtonEnter = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (reduced || disabled || event.pointerType === 'touch') return
    animate(hoverScale, scale, HOVER_SPRING)
  }
  const onButtonLeave = () => {
    if (reduced) return
    animate(hoverScale, 1, HOVER_SPRING)
  }
  const onTouchDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (reduced || event.pointerType !== 'touch') return
    animate(hoverScale, TOUCH_SCALE, HOVER_SPRING)
  }
  const onTouchUp = () => {
    if (reduced) return
    animate(hoverScale, 1, HOVER_SPRING)
  }

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={() => {
        if (!disabled) onClick?.()
      }}
      onPointerEnter={onButtonEnter}
      onPointerLeave={onButtonLeave}
      onPointerDown={onTouchDown}
      onPointerUp={onTouchUp}
      onPointerCancel={onTouchUp}
      style={{ x, y, scale: hoverScale }}
      className={`relative flex items-center justify-center will-change-transform select-none touch-manipulation focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[#C9F45A] ${className ?? ''}`}
    >
      {glow && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{ background: glowBackground, opacity: glowOpacity }}
        />
      )}
      <motion.span className="relative z-10 inline-flex items-center justify-center" style={{ x: labelX, y: labelY }}>
        {children}
      </motion.span>
    </motion.button>
  )
}
