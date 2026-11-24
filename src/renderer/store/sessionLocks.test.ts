import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './index'

const existingUuid = '00000000-0000-4000-8000-000000000001'
const conversationUuid = '00000000-0000-4000-8000-000000000002'

beforeEach(() => useAppStore.setState({
  lockedSessionIds: [],
  pendingSessionLocks: [],
  sessionLocksLoaded: false,
}))

afterEach(() => vi.unstubAllGlobals())

describe('session lock persistence', () => {
  it('loads the saved locks first and only shows a new lock after persistence confirms it', async () => {
    const hydration = Promise.withResolvers<string[]>()
    const save = Promise.withResolvers<boolean>()
    const getStore = vi.fn(() => hydration.promise)
    const persistLock = vi.fn(() => save.promise)
    vi.stubGlobal('window', { electronAPI: { getStore, setSessionLocked: persistLock } })

    const { loadSessionLocks, setSessionLocked } = useAppStore.getState()
    const load = loadSessionLocks()
    const lock = setSessionLocked(conversationUuid, true)
    expect(await setSessionLocked(conversationUuid, false)).toBe('pending')
    expect(persistLock).not.toHaveBeenCalled()

    hydration.resolve([existingUuid])
    expect(await load).toBe(true)
    expect(getStore.mock.calls).toEqual([['lockedSessionIds']])
    expect(persistLock.mock.calls).toEqual([[conversationUuid, true]])
    expect(useAppStore.getState()).toMatchObject({
      lockedSessionIds: [existingUuid],
      pendingSessionLocks: [conversationUuid],
    })

    save.resolve(true)
    expect(await lock).toBe('saved')
    expect(useAppStore.getState()).toMatchObject({
      lockedSessionIds: [existingUuid, conversationUuid],
      pendingSessionLocks: [],
    })
  })

  it('keeps the last confirmed state when either saving a lock or saving an unlock fails', async () => {
    const getStore = vi.fn().mockResolvedValue([existingUuid])
    const persistLock = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('write failed'))
    vi.stubGlobal('window', { electronAPI: { getStore, setSessionLocked: persistLock } })

    const { setSessionLocked } = useAppStore.getState()
    expect(await setSessionLocked(conversationUuid, true)).toBe('failed')
    expect(await setSessionLocked(existingUuid, false)).toBe('failed')
    expect(useAppStore.getState()).toMatchObject({
      lockedSessionIds: [existingUuid],
      pendingSessionLocks: [],
    })
  })

  it('preserves two independent writes that are acknowledged in reverse order', async () => {
    const first = Promise.withResolvers<boolean>()
    const second = Promise.withResolvers<boolean>()
    const getStore = vi.fn().mockResolvedValue([])
    const persistLock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electronAPI: { getStore, setSessionLocked: persistLock } })

    const { setSessionLocked } = useAppStore.getState()
    const firstLock = setSessionLocked(existingUuid, true)
    const secondLock = setSessionLocked(conversationUuid, true)

    second.resolve(true)
    expect(await secondLock).toBe('saved')
    expect(useAppStore.getState().lockedSessionIds).toEqual([conversationUuid])
    first.resolve(true)
    expect(await firstLock).toBe('saved')
    expect(useAppStore.getState().lockedSessionIds).toEqual([conversationUuid, existingUuid])
  })
})
