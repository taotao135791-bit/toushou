import { describe, expect, it, vi } from 'vitest'
import type { UpdaterStatus } from '@shared/types'
import { subscribeUpdaterStatus } from './updaterStatus'

function fixture() {
  let resolve!: (status: UpdaterStatus) => void
  let event!: (status: UpdaterStatus) => void
  const unsubscribe = vi.fn()
  const api = {
    updaterGetStatus: () => new Promise<UpdaterStatus>(done => { resolve = done }),
    onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => { event = callback; return unsubscribe }
  }
  return { api, event: (status: UpdaterStatus) => event(status), resolve: (status: UpdaterStatus) => resolve(status), unsubscribe }
}

describe('updater status subscription', () => {
  it('loads an already discovered release for a newly opened window', async () => {
    const f = fixture(), receive = vi.fn()
    subscribeUpdaterStatus(receive, f.api)
    f.resolve({ status: 'available', version: '2.1.0' })
    await Promise.resolve()
    expect(receive).toHaveBeenLastCalledWith({ status: 'available', version: '2.1.0' })
  })
  it('keeps a live available event when an older startup snapshot resolves later', async () => {
    const f = fixture(), receive = vi.fn()
    subscribeUpdaterStatus(receive, f.api)
    f.event({ status: 'available', version: '2.1.0' })
    f.resolve({ status: 'idle' })
    await Promise.resolve()
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenLastCalledWith({ status: 'available', version: '2.1.0' })
  })
  it('does not update an unmounted surface', async () => {
    const f = fixture(), receive = vi.fn()
    const stop = subscribeUpdaterStatus(receive, f.api)
    stop()
    f.resolve({ status: 'available', version: '2.1.0' })
    f.event({ status: 'available', version: '2.2.0' })
    await Promise.resolve()
    expect(receive).not.toHaveBeenCalled()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
