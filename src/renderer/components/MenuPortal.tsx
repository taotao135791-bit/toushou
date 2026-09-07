import { ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Keep this many pixels of daylight between the menu and the window edge. */
const VIEWPORT_MARGIN = 8
/** Gap between the trigger edge and the menu. */
const TRIGGER_GAP = 6

/**
 * Dropdown menu portaled to document.body. By default it is anchored ABOVE
 * the trigger (composer toolbars); `placement="bottom"` drops it BELOW the
 * trigger for top-bar menus. Menus rendered inside the composer toolbar get
 * clipped by its overflow-x-auto (a clipped axis computes the other axis to
 * 'auto' too), which made them invisible and unclickable — the portal
 * escapes that.
 *
 * The trigger passes its own ref; the anchor rect is captured on open.
 * Positioning is two-phase and settles before the first paint: the menu is
 * first parked invisibly at the trigger, then measured (offsetWidth/Height)
 * and clamped into the viewport with VIEWPORT_MARGIN — horizontal overflow
 * shifts it sideways, vertical overflow flips the placement (bottom↔top).
 * A menu taller than the viewport scrolls via `maxHeight`.
 *
 * `onClose` fires on any pointerdown outside both trigger and menu, or on
 * Escape.
 */
export default function MenuPortal({
  open,
  triggerRef,
  onClose,
  width,
  maxHeight,
  placement = 'top',
  children
}: {
  open: boolean
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  width?: number
  maxHeight?: number
  /** 'top' floats above the trigger (default); 'bottom' drops below it. */
  placement?: 'top' | 'bottom'
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number; measured: boolean } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      // Phase 1: park at the trigger, invisible, so phase 2 can measure the
      // rendered menu before anything is painted.
      setAnchor({ left: rect.left, top: rect.top, measured: false })
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, triggerRef, placement])

  // Phase 2: the menu is in the DOM — measure it and clamp into the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor || anchor.measured) return
    const menu = menuRef.current
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!menu || !rect) return
    const menuWidth = menu.offsetWidth
    const menuHeight = menu.offsetHeight
    let left = Math.min(rect.left, window.innerWidth - menuWidth - VIEWPORT_MARGIN)
    left = Math.max(left, VIEWPORT_MARGIN)
    let top: number
    if (placement === 'bottom') {
      top = rect.bottom + TRIGGER_GAP
      if (top + menuHeight > window.innerHeight - VIEWPORT_MARGIN) {
        // Would run off the bottom: flip above the trigger instead.
        top = rect.top - TRIGGER_GAP - menuHeight
      }
    } else {
      top = rect.top - TRIGGER_GAP - menuHeight
      if (top < VIEWPORT_MARGIN) {
        // Would run off the top: flip below the trigger instead.
        top = rect.bottom + TRIGGER_GAP
      }
    }
    // Menu taller than the viewport: maxHeight makes it scroll — pin the box
    // inside the margins.
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - menuHeight - VIEWPORT_MARGIN))
    setAnchor({ left, top, measured: true })
  }, [open, anchor, placement, triggerRef])

  if (!open || !anchor) return null
  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: anchor.left,
        top: anchor.top,
        zIndex: 50,
        visibility: anchor.measured ? undefined : 'hidden',
        width,
        maxHeight
      }}
      className="overflow-y-auto rounded-xl border border-line bg-ink-850 p-1 shadow-pop"
    >
      {children}
    </div>,
    document.body
  )
}
