import { animate, useMotionValue, useReducedMotion } from 'motion/react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * 滑块果冻拉伸（与 JellyToggle 同一手感，参数按滑块尺寸缩放）：
 * 按住拖动时滑块跟手拉伸（scaleX 放宽 / scaleY 压扁，origin 在拖尾边），
 * 松手后一条 bounce 弹簧把形变弹回 1。原生 input 保留全部交互，
 * 这里只是被动叠加视觉层。
 */
export interface JellyStretch {
  scaleX: ReturnType<typeof useMotionValue<number>>
  scaleY: ReturnType<typeof useMotionValue<number>>
  origin: 'center' | 'left' | 'right'
  handlers: {
    onPointerDown: (event: ReactPointerEvent) => void
    onPointerMove: (event: ReactPointerEvent) => void
    onPointerUp: (event: ReactPointerEvent) => void
    onPointerCancel: (event: ReactPointerEvent) => void
  }
}

export function useJellyStretch(options: { knobSize: number; maxStretch: number; bounce?: number; visualDuration?: number }): JellyStretch {
  const { knobSize, maxStretch, bounce = 0.15, visualDuration = 0.35 } = options
  const reduced = useReducedMotion()
  const scaleX = useMotionValue(1)
  const scaleY = useMotionValue(1)
  const [origin, setOrigin] = useState<'center' | 'left' | 'right'>('center')
  const startX = useRef<number | null>(null)

  const settle = () => {
    if (startX.current === null) return
    startX.current = null
    if (scaleX.get() === 1 && scaleY.get() === 1) return
    const spring = { type: 'spring' as const, visualDuration, bounce }
    animate(scaleX, 1, spring)
    const done = animate(scaleY, 1, spring)
    // 形变精确回 1 后再复位 origin，避免飞行中视觉跳位。
    void Promise.resolve(done).then(() => setOrigin('center')).catch(() => undefined)
  }

  return {
    scaleX,
    scaleY,
    origin,
    handlers: {
      onPointerDown: (event) => {
        startX.current = event.clientX
      },
      onPointerMove: (event) => {
        if (startX.current === null) return
        const dx = event.clientX - startX.current
        if (reduced || Math.abs(dx) <= 2) return
        const ratio = Math.min(maxStretch, Math.abs(dx)) / knobSize
        scaleX.set(1 + ratio)
        scaleY.set(1 - 0.38 * ratio)
        setOrigin(dx > 0 ? 'left' : 'right')
      },
      onPointerUp: settle,
      onPointerCancel: settle
    }
  }
}
