import { flushSync } from 'react-dom'

interface ViewTransitionLike {
  ready: Promise<void>
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike
}

export type RevealDirection = 'expand' | 'retract'

/**
 * Circular reveal built on the View Transitions API (native in Electron's
 * Chromium). The OLD frame is snapshotted; the new one is revealed by a
 * clipping circle anchored at the clicked control.
 *
 * - expand  (→ dark): the new frame grows from the click point.
 * - retract (→ light): the old frame shrinks INTO the click point, so light
 *   feels like it is being pulled back in rather than pushed out.
 *
 * Falls back to an instant switch with reduced-motion or no API support.
 */
export function runRevealTransition(
  apply: () => void,
  origin: { x: number; y: number } | undefined,
  direction: RevealDirection
): void {
  const doc = document as DocumentWithViewTransition
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (typeof doc.startViewTransition !== 'function' || reduce) {
    apply()
    return
  }
  const x = origin?.x ?? window.innerWidth / 2
  const y = origin?.y ?? window.innerHeight / 2
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  const root = document.documentElement
  root.classList.add(direction === 'retract' ? 'vt-retract' : 'vt-expand')
  const cleanup = () => root.classList.remove('vt-retract', 'vt-expand')
  let transition: ViewTransitionLike
  try {
    transition = doc.startViewTransition(() => {
      flushSync(apply)
    })
  } catch {
    cleanup()
    apply()
    return
  }
  transition.ready
    .then(async () => {
      const clip = direction === 'retract'
        ? [`circle(${radius}px at ${x}px ${y}px)`, `circle(0px at ${x}px ${y}px)`]
        : [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
      const animation = document.documentElement.animate(
        { clipPath: clip },
        {
          duration: 620,
          easing: 'cubic-bezier(0.32, 0, 0.2, 1)',
          pseudoElement: direction === 'retract' ? '::view-transition-old(root)' : '::view-transition-new(root)'
        }
      )
      // Keep the layering class for the WHOLE animation; a failed/cancelled
      // animation must not leave it pinned on <html>.
      await animation.finished.catch(() => {})
    })
    .catch(() => {
      // A failed animation still leaves the new state applied.
    })
    .finally(cleanup)
}

/** Dark → light retracts, light → dark expands. */
export function runThemeTransition(apply: () => void, origin?: { x: number; y: number }, nextTheme?: 'dark' | 'light'): void {
  runRevealTransition(apply, origin, nextTheme === 'light' ? 'retract' : 'expand')
}

/** Language switches reuse the same reveal (text ripples out from the control). */
export function runLanguageTransition(apply: () => void, origin?: { x: number; y: number }): void {
  runRevealTransition(apply, origin, 'expand')
}
