import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Measure an element's width via ResizeObserver and quantize it to one
 * boolean: `compact` is true while the element is narrower than
 * `breakpoint` px. Consumers render against the boolean, never the raw
 * pixel value, so a drag-resize re-renders the subtree only when the
 * breakpoint is actually crossed — not on every pixel.
 *
 * Unmeasured (before the first observation) reads as `false` — the wide
 * layout — matching the typical full-window home view; the synchronous
 * first read in the layout effect means the very first paint already
 * reflects the real width.
 */
export default function useElementWidth<T extends HTMLElement>(
  breakpoint: number
): { ref: React.RefObject<T>; compact: boolean } {
  const ref = useRef<T>(null)
  const [compact, setCompact] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (width: number) => setCompact(width > 0 && width < breakpoint)
    apply(el.getBoundingClientRect().width)
    // jsdom (tests) has no ResizeObserver; the one-shot read above still
    // holds, it just never tracks later resizes.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) apply(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [breakpoint])

  return { ref, compact }
}
