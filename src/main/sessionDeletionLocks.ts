import { isSessionUuid } from './sessionHistory'

export interface SessionDeletionGuard {
  isLocked(uuid: unknown): boolean
  runDeletion<T>(uuids: readonly unknown[], operation: () => Promise<T>): Promise<T | 'locked'>
}

/** UI lock changes and irreversible work on the same durable id share one Main authority. */
export function createSessionDeletionLocks(read: () => unknown, write: (ids: string[]) => void) {
  const pending = new Map<string, number>()
  const readIds = () => {
    const raw = read()
    if (!Array.isArray(raw)) throw new Error('Invalid session lock settings')
    return raw.filter(isSessionUuid)
  }
  const isLocked: SessionDeletionGuard['isLocked'] =
    uuid => isSessionUuid(uuid) && readIds().includes(uuid)

  return {
    isLocked,
    setLocked(uuid: unknown, locked: unknown): boolean {
      if (!isSessionUuid(uuid) || typeof locked !== 'boolean' || pending.has(uuid)) return false
      try {
        const ids = readIds()
        if (ids.includes(uuid) !== locked) {
          write(locked ? [...ids, uuid] : ids.filter(id => id !== uuid))
        }
        return true
      } catch {
        return false
      }
    },
    async runDeletion<T>(uuids: readonly unknown[], operation: () => Promise<T>): Promise<T | 'locked'> {
      const ids = new Set(uuids.filter(isSessionUuid))
      if (ids.size > 0) {
        const locked = new Set(readIds())
        if ([...ids].some(id => locked.has(id))) return 'locked'
      }
      for (const id of ids) pending.set(id, (pending.get(id) ?? 0) + 1)
      try {
        return await operation()
      } finally {
        for (const id of ids) {
          const remaining = (pending.get(id) ?? 1) - 1
          if (remaining) pending.set(id, remaining)
          else pending.delete(id)
        }
      }
    }
  }
}
