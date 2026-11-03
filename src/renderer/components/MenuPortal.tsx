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
 * Position once before the first paint, then observe actual size/scroll
 * changes. Parent rerenders must never hide and remeasure an open menu.
 * Horizontal overflow shifts sideways; vertical overflow flips placement.
 * Menus taller than the viewport scroll inside its margins.
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
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return }
    const position = () => {
      const menu = menuRef.current
      const trigger = triggerRef.current
      if (!menu || !trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuWidth = menu.offsetWidth
      const menuHeight = menu.offsetHeight
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - menuWidth - VIEWPORT_MARGIN))
      let top = placement === 'bottom' ? rect.bottom + TRIGGER_GAP : rect.top - TRIGGER_GAP - menuHeight
      if (placement === 'bottom' && top + menuHeight > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - TRIGGER_GAP - menuHeight
      else if (placement === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + TRIGGER_GAP
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - menuHeight - VIEWPORT_MARGIN))
      setAnchor(previous => previous?.left === left && previous.top === top ? previous : { left, top })
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closeRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        triggerRef.current?.focus()
      }
    }
    position()
    const observer = new ResizeObserver(position)
    if (menuRef.current) observer.observe(menuRef.current)
    if (triggerRef.current) observer.observe(triggerRef.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, triggerRef, placement, width, maxHeight])

  if (!open) return null

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: anchor?.left ?? 0,
        top: anchor?.top ?? 0,
        zIndex: 50,
        visibility: anchor ? undefined : 'hidden',
        width,
        maxHeight: maxHeight === undefined ? 'calc(100dvh - 16px)' : `min(${maxHeight}px, calc(100dvh - 16px))`
      }}
      className="overflow-y-auto rounded-xl border border-line bg-ink-850 p-1 shadow-pop"
    >
      {children}
    </div>,
    document.body
  )
}
