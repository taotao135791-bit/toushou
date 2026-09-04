import { useSyncExternalStore } from 'react'
import { I18nKey } from '../i18n'

/**
 * Featherweight global toast for spots that cannot surface an inline error
 * (e.g. a sidebar action that fails before any page owns the feedback).
 * Deliberately not store-backed: a notice is transient UI chrome, never app
 * state, so it must not re-render session subscribers.
 */
interface Notice {
  key: I18nKey
  id: number
}

let current: Notice | null = null
let nextId = 0
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())

/** Show a transient notice; a newer one replaces and outlives an older one. */
export function showNotice(key: I18nKey, durationMs = 3000): void {
  const id = ++nextId
  current = { key, id }
  emit()
  setTimeout(() => {
    if (current?.id !== id) return
    current = null
    emit()
  }, durationMs)
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => current
  )
}
