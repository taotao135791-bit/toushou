import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Two-stage confirm for destructive actions: the first click arms, the second
 * click within `timeoutMs` fires `onConfirm`. The armed state self-clears
 * after the timeout; the timer is cleaned up on unmount.
 */
export function useConfirm(onConfirm: () => void, timeoutMs = 3000) {
  const [confirming, setConfirming] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const action = useRef(onConfirm)
  action.current = onConfirm

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const click = useCallback(() => {
    if (!confirming) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setConfirming(false), timeoutMs)
      setConfirming(true)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setConfirming(false)
    action.current()
  }, [confirming, timeoutMs])

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setConfirming(false)
  }, [])

  return { confirming, click, reset }
}

/**
 * Id-keyed variant of `useConfirm` for lists: arming one row re-arms (never
 * fires) when a different row is clicked. `null` means nothing is armed.
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
