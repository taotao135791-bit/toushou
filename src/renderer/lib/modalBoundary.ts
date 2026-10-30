import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

type ModalEntry = { root: HTMLElement; previous: HTMLElement | null }
const stack: ModalEntry[] = []
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshot = () => stack.length > 0

/** BrowserPage uses this shared state to park its native view while a modal is open. */
export function useBrowserSuspendedForModal(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
const focusable = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
)).filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]'))

/** Trap keyboard focus, restore the opener, and keep native browser views parked. */
export function useModalBoundary(ref: RefObject<HTMLElement>, open: boolean, onEscape?: () => void): void {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  wasOpen.current = open
  useLayoutEffect(() => {
    const root = ref.current
    if (!open || !root) return
    const entry: ModalEntry = { root, previous: opener.current }
    stack.push(entry)
    notify()
    const first = () => focusable(root)[0] ?? root
    const autofocus = root.querySelector<HTMLElement>('[autofocus]')
    ;(autofocus ?? first()).focus()
    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== entry) return
      if (event.key === 'Escape' && !event.isComposing && escapeRef.current) {
        event.preventDefault()
        event.stopPropagation()
        escapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable(root)
      if (!items.length) { event.preventDefault(); root.focus(); return }
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus() }
      else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus() }
    }
    const onFocus = (event: FocusEvent) => {
      if (stack[stack.length - 1] === entry && event.target instanceof Node && !root.contains(event.target)) first().focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
      const index = stack.indexOf(entry)
      const top = index === stack.length - 1
      if (index >= 0) stack.splice(index, 1)
      notify()
      if (top) {
        const remaining = stack[stack.length - 1]
        if (entry.previous?.isConnected && (!remaining || remaining.root.contains(entry.previous))) entry.previous.focus()
        else if (remaining) (focusable(remaining.root)[0] ?? remaining.root).focus()
      }
    }
  }, [open, ref])
}
