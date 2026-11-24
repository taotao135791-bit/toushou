import { createContext, useContext, ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Keep this many pixels of daylight between the menu and the window edge. */
const VIEWPORT_MARGIN = 8
/** Gap between the trigger edge and the menu. */
const TRIGGER_GAP = 6

/** Home menus grow into the space below the composer and scroll there. */
export const ComposerMenuPlacement = createContext<'top' | 'below'>('top')

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
  placement: requestedPlacement,
  align = 'start',
  initialFocusRef,
  children
}: {
  open: boolean
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  width?: number
  maxHeight?: number
  /** 'top' floats above the trigger (default); 'bottom' drops below it. */
  placement?: 'top' | 'bottom'
  align?: 'start' | 'end'
  initialFocusRef?: React.RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const composerPlacement = useContext(ComposerMenuPlacement)
  const placement = requestedPlacement ?? composerPlacement
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [anchor, setAnchor] = useState<{ left: number; top: number; room?: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return }
    if (placement === 'below' && triggerRef.current && window.innerHeight - triggerRef.current.getBoundingClientRect().bottom < 100) {
      triggerRef.current.scrollIntoView({ block: 'center' })
    }
    const position = () => {
      const menu = menuRef.current
      const trigger = triggerRef.current
      if (!menu || !trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuWidth = menu.offsetWidth
      const menuHeight = menu.offsetHeight
      const margin = align === 'end' ? 16 : VIEWPORT_MARGIN
      const desiredLeft = align === 'end' ? rect.right - menuWidth : rect.left
      const left = Math.max(margin, Math.min(desiredLeft, window.innerWidth - menuWidth - margin))
      if (placement === 'below') {
        const top = rect.bottom + TRIGGER_GAP
        const room = Math.max(1, Math.floor(window.innerHeight - top - VIEWPORT_MARGIN))
        setAnchor(previous => previous?.left === left && previous.top === top && previous.room === room ? previous : { left, top, room })
        return
      }
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
  }, [open, triggerRef, placement, align, width, maxHeight])

  const positioned = open && anchor !== null
  useLayoutEffect(() => {
    if (!positioned || !initialFocusRef) return
    // A menu action can replace its focused portal during a native click.
    // Let Chromium finish that focus transition before moving into this menu.
    const timer = window.setTimeout(() => {
      const menu = menuRef.current
      const target = initialFocusRef.current
      if (target?.isConnected && menu?.contains(target) && !menu.contains(document.activeElement)) target.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [positioned, initialFocusRef])

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
        maxWidth: align === 'end' ? 'calc(100vw - 32px)' : 'calc(100vw - 16px)',
        maxHeight: anchor?.room !== undefined ? Math.min(maxHeight ?? Infinity, anchor.room) : maxHeight === undefined ? 'calc(100dvh - 16px)' : `min(${maxHeight}px, calc(100dvh - 16px))`
      }}
      className="overflow-y-auto rounded-xl border border-line bg-ink-850 p-1 shadow-pop"
    >
      {children}
    </div>,
    document.body
  )
}
