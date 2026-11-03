import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './index'
import type { HistorySessionDescriptor, HistorySessionRow } from '@shared/types'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => useAppStore.setState({ currentWorkspace: { id: 'grant', realPath: '/synthetic/a', displayPath: '/synthetic/a', source: 'dialog', createdAt: 1 }, globalHistory: [], sessionRecords: [], historyLoading: false }))
afterEach(() => vi.unstubAllGlobals())
describe('history scan ordering', () => {
  it('keeps the latest global scan when an older scan resolves late', async () => {
    const old = deferred<HistorySessionRow[]>(), fresh = deferred<HistorySessionRow[]>()
    vi.stubGlobal('window', { electronAPI: { listAllSessionHistory: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) } })
    const first = useAppStore.getState().loadAllHistorySessions(), second = useAppStore.getState().loadAllHistorySessions()
    fresh.resolve([{ uuid: 'fresh', title: 'Latest', cwd: '/synthetic/a', timestamp: 2 }]); await second
    old.resolve([{ uuid: 'old', title: 'Stale', cwd: '/synthetic/a', timestamp: 1 }]); await first
    expect(useAppStore.getState().globalHistory.map(row => row.uuid)).toEqual(['fresh'])
  })
  it('does not resurrect a deleted UUID from a pending or later stale scan', async () => {
    const global = deferred<HistorySessionRow[]>(), scoped = deferred<HistorySessionDescriptor[]>()
    const row = { uuid: 'deleted-by-scan-test', title: 'Deleted', cwd: '/synthetic/a', timestamp: 1 }
    vi.stubGlobal('window', { electronAPI: { listAllSessionHistory: vi.fn().mockReturnValueOnce(global.promise).mockResolvedValue([row]), listSessionHistory: vi.fn().mockReturnValue(scoped.promise) } })
    const globalRead = useAppStore.getState().loadAllHistorySessions(), scopedRead = useAppStore.getState().loadHistorySessions('grant')
    useAppStore.getState().purgeDeletedSession(row.uuid)
    global.resolve([row]); scoped.resolve([{ id: 'opaque', uuid: row.uuid, title: row.title, timestamp: row.timestamp }])
    await Promise.all([globalRead, scopedRead])
    await useAppStore.getState().loadAllHistorySessions()
    expect(useAppStore.getState().globalHistory).toEqual([])
    expect(useAppStore.getState().sessionRecords).toEqual([])
    expect(useAppStore.getState().historyLoading).toBe(false)
  })
  it('coalesces same-generation scans for the same grant', async () => {
    const fresh = deferred<HistorySessionDescriptor[]>()
    const list = vi.fn().mockReturnValue(fresh.promise)
    vi.stubGlobal('window', { electronAPI: { listSessionHistory: list } })
    const first = useAppStore.getState().loadHistorySessions('grant'), second = useAppStore.getState().loadHistorySessions('grant')
    expect(list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().historyLoading).toBe(true)
    fresh.resolve([{ id: 'fresh-cap', uuid: 'one', title: 'Updated', timestamp: 2 }]); await Promise.all([first, second])
    expect(useAppStore.getState().sessionRecords[0].history?.id).toBe('fresh-cap')
    expect(useAppStore.getState().historyLoading).toBe(false)
  })

  it('starts a fresh A scan after A → B → A instead of reviving an obsolete promise', async () => {
    const oldA = deferred<HistorySessionDescriptor[]>(), oldB = deferred<HistorySessionDescriptor[]>(), freshA = deferred<HistorySessionDescriptor[]>()
    const list = vi.fn().mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise).mockReturnValueOnce(freshA.promise)
    vi.stubGlobal('window', { electronAPI: { listSessionHistory: list } })
    const first = useAppStore.getState().loadHistorySessions('grant')
    useAppStore.setState({ currentWorkspace: { id: 'grant-b', realPath: '/synthetic/b', displayPath: '/synthetic/b', source: 'dialog', createdAt: 1 } })
    const second = useAppStore.getState().loadHistorySessions('grant-b')
    useAppStore.setState({ currentWorkspace: { id: 'grant', realPath: '/synthetic/a', displayPath: '/synthetic/a', source: 'dialog', createdAt: 1 } })
    const third = useAppStore.getState().loadHistorySessions('grant')
    expect(list.mock.calls.map(call => call[0])).toEqual(['grant', 'grant-b', 'grant'])
    oldA.resolve([{ id: 'old-a', uuid: 'a', title: 'Old A', timestamp: 1 }]); oldB.resolve([])
    await Promise.all([first, second])
    expect(useAppStore.getState().historyLoading).toBe(true)
    freshA.resolve([{ id: 'new-a', uuid: 'a', title: 'Fresh A', timestamp: 2 }]); await third
    expect(useAppStore.getState().historyLoading).toBe(false)
    expect(useAppStore.getState().sessionRecords[0].history?.id).toBe('new-a')
  })
})
