import { ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Dropdown menu portaled to document.body, anchored above the trigger.
 * Menus rendered inside the composer toolbar get clipped by its
 * overflow-x-auto (a clipped axis computes the other axis to 'auto' too),
 * which made them invisible and unclickable — the portal escapes that.
 *
 * The trigger passes its own ref; the anchor rect is captured on open.
 * `onClose` fires on any pointerdown outside both trigger and menu, or on
 * Escape.
 */
export default function MenuPortal({
  open,
  triggerRef,
  onClose,
  width,
  maxHeight,
  children
}: {
  open: boolean
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  width?: number
  maxHeight?: number
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
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
  }, [open, onClose, triggerRef])

  if (!open || !anchor) return null
  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: anchor.left,
        bottom: anchor.bottom,
        zIndex: 50,
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
