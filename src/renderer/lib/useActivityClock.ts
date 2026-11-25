import { useSyncExternalStore } from 'react'

// All visible activity timers share one heartbeat, stopped as soon as the
// last active subscriber leaves. Idle and historical rows have no listener.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let now = 0
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (timer === undefined) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const update of listeners) update()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
      now = 0
    }
  }
}
const idle = () => () => {}
const snapshot = () => now
const zero = () => 0

export function useActivityClock(active: boolean) {
  return useSyncExternalStore(active ? subscribe : idle, active ? snapshot : zero)
}
