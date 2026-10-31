import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Two-stage confirm for the remaining inline cases (archive in the sidebar):
 * the first click arms, the second click within `timeoutMs` fires
 * `onConfirm`. The armed state self-clears after the timeout; the timer is
 * cleaned up on unmount. Permanent deletions moved to the centered
 * ConfirmDialog — do not add new uses of this hook for destructive actions.
 */
export function useConfirmId<T>(onConfirm: (id: T) => void, timeoutMs = 3000) {
  const [confirmingId, setConfirmingId] = useState<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const action = useRef(onConfirm)
  action.current = onConfirm

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const click = useCallback(
    (id: T) => {
      if (confirmingId !== id) {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setConfirmingId(null), timeoutMs)
        setConfirmingId(id)
        return
      }
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setConfirmingId(null)
      action.current(id)
    },
    [confirmingId, timeoutMs]
  )

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setConfirmingId(null)
  }, [])

  return { confirmingId, click, reset }
}
