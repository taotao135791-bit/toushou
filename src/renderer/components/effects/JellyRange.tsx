import { animate, motion, useMotionValue } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useJellyStretch } from './useJellyStretch'

interface JellyRangeProps {
  min: number
  max: number
  value: number
  onChange: (value: number) => void
  /** 无障碍名称（不可见的原生 input 仍负责键盘与读屏）。 */
  label: string
  /** 轨道宽度（外层通常 flex-1）。 */
  className?: string
}

const THUMB = 18
const RAIL = 6

/**
 * 果冻滑块：看不见的原生 `input[type=range]` 铺满轨道负责全部交互
 * （拖动、键盘、读屏），可见层是轨道 + 填充 + 一颗拖动时果冻拉伸、
 * 松手弹簧回弹的滑块。尺寸按面板密度缩放（拇指 18px）。
 */
export default function JellyRange({ min, max, value, onChange, label, className }: JellyRangeProps) {
  const fraction = max > min ? (value - min) / (max - min) : 0
  const jelly = useJellyStretch({ knobSize: THUMB, maxStretch: 6 })
  const thumbX = useMotionValue(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const trackWidth = useRef(0)
  const dragging = useRef(false)

  // 拇指位移只走 transform：拖动中 1:1 跟手，键盘/程序跳变走弹簧。
  const fractionRef = useRef(fraction)
  fractionRef.current = fraction
  const syncThumb = (animateMove: boolean) => {
    if (trackWidth.current <= 0) return
    const target = THUMB / 2 + (trackWidth.current - THUMB) * fractionRef.current
    if (animateMove) animate(thumbX, target, { type: 'spring', visualDuration: 0.35, bounce: 0.15 })
    else thumbX.set(target)
  }

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      trackWidth.current = el.clientWidth
      syncThumb(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    syncThumb(!dragging.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fraction])

  return (
    <div ref={trackRef} className={`relative h-5 ${className ?? ''}`}>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full border border-line bg-ink-850"
        style={{ height: RAIL }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[rgb(var(--accent))]"
          style={{ width: `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${fraction})` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onPointerDown={(event) => {
          dragging.current = true
          jelly.handlers.onPointerDown(event)
        }}
        onPointerMove={jelly.handlers.onPointerMove}
        onPointerUp={(event) => {
          dragging.current = false
          jelly.handlers.onPointerUp(event)
        }}
        onPointerCancel={(event) => {
          dragging.current = false
          jelly.handlers.onPointerCancel(event)
        }}
        className="absolute inset-0 m-0 w-full cursor-pointer appearance-none bg-transparent opacity-0"
      />
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0 rounded-full border border-[#dedce6] bg-white"
        style={{
          width: THUMB,
          height: THUMB,
          marginTop: -THUMB / 2,
          boxShadow: '0 1px 3px rgb(24 45 71 / 0.18)',
          x: thumbX,
          scaleX: jelly.scaleX,
          scaleY: jelly.scaleY,
          transformOrigin: jelly.origin
        }}
      />
    </div>
  )
}
