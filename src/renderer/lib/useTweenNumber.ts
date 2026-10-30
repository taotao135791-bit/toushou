import { useEffect, useRef, useState } from 'react'

const TWEEN_MS = 320
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

/**
 * Animate a number toward its new value instead of snapping. Board cards
 * refresh in bursts (dataset reload), so a raw swap reads as a flicker;
 * counting up/down makes the change legible. Respects reduced-motion.
 */
export function useTweenNumber(target: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(target)
  const fromRef = useRef<number | null>(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (target === null) {
      setDisplay(null)
      fromRef.current = null
      return
    }
    const from = fromRef.current ?? target
    if (from === target) {
      setDisplay(target)
      return
    }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / TWEEN_MS)
      setDisplay(t >= 1 ? target : from + (target - from) * easeOutCubic(t))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      fromRef.current = target
    }
  }, [target])

  return display
}
