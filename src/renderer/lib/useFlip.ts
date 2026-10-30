import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * FLIP list animation: rows marked with `data-flip-id` glide to their new
 * position instead of jump-cutting when the order changes (e.g. a session
 * floats to the top after switch-away). Only transform is animated, so it
 * stays on the compositor; rows whose position did not change are untouched.
 */
export function useFlip(containerRef: RefObject<HTMLElement | null>): void {
  const lastPositions = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const rootTop = root.getBoundingClientRect().top - root.scrollTop
    const next = new Map<string, number>()
    const moved: Array<{ node: HTMLElement; delta: number }> = []
    for (const node of root.querySelectorAll<HTMLElement>('[data-flip-id]')) {
      const id = node.dataset.flipId
      if (!id) continue
      const top = node.getBoundingClientRect().top - rootTop
      next.set(id, top)
      const previous = lastPositions.current.get(id)
      if (previous !== undefined && Math.abs(previous - top) > 1) {
        moved.push({ node, delta: previous - top })
      }
    }
    lastPositions.current = next
    if (moved.length === 0) return
    for (const { node, delta } of moved) {
      // Snap to the old position, then transition back to the real one.
      node.style.transition = 'none'
      node.style.transform = `translateY(${delta}px)`
    }
    // Force a style flush so the start position is committed before animating.
    void root.offsetHeight
    for (const { node } of moved) {
      node.style.transition = 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)'
      node.style.transform = ''
      const clear = () => {
        node.style.transition = ''
        node.removeEventListener('transitionend', clear)
      }
      node.addEventListener('transitionend', clear)
    }
  })
}
