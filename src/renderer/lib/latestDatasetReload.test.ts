import { describe, expect, it, vi } from 'vitest'
import { reloadLatestDataset, type DatasetReloadState } from './latestDatasetReload'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('latest dataset reload', () => {
  it('follows a later successful read instead of marking the earlier read failed', async () => {
    const first = deferred<number>(), second = deferred<number>()
    const state: DatasetReloadState = { generation: 0, latest: null }
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const accept = vi.fn(), fail = vi.fn()
    const a = reloadLatestDataset(state, read, accept, fail)
    const b = reloadLatestDataset(state, read, accept, fail)
    first.resolve(1)
    second.resolve(2)
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith(2)
    expect(fail).not.toHaveBeenCalled()
  })

  it('reports the latest real failure, not an earlier success', async () => {
    const first = deferred<number>(), second = deferred<number>()
    const state: DatasetReloadState = { generation: 0, latest: null }
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const accept = vi.fn(), fail = vi.fn()
    const a = reloadLatestDataset(state, read, accept, fail)
    const b = reloadLatestDataset(state, read, accept, fail)
    first.resolve(1)
    second.reject(new Error('synthetic I/O'))
    expect(await Promise.all([a, b])).toEqual([false, false])
    expect(accept).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledOnce()
  })
})
