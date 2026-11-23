import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/synthetic-keepalive-test' }, powerMonitor: { on: vi.fn(), removeListener: vi.fn() } }))

import { tokenKeepAlive } from '../tokenKeepAlive'

describe('tokenKeepAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    tokenKeepAlive.stop()
    tokenKeepAlive.registerTarget('reset', async () => true)
    tokenKeepAlive['targets'].delete('reset')
  })
  afterEach(() => {
    tokenKeepAlive.stop()
    vi.useRealTimers()
  })

  it('runs every registered target on the interval and on the first tick', async () => {
    const calls: string[] = []
    tokenKeepAlive.registerTarget('tiktok', async () => { calls.push('tiktok'); return true })
    tokenKeepAlive.registerTarget('appsflyer', async () => { calls.push('appsflyer'); return true })
    tokenKeepAlive.start()
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toEqual(['tiktok', 'appsflyer'])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(calls).toEqual(['tiktok', 'appsflyer', 'tiktok', 'appsflyer'])
  })

  it('a throwing target never blocks the others or crashes the tick', async () => {
    const ok = vi.fn(async () => true)
    tokenKeepAlive.registerTarget('bad', async () => { throw new Error('boom') })
    tokenKeepAlive.registerTarget('good', ok)
    tokenKeepAlive.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('overlapping ticks are skipped while one is still running', async () => {
    let release!: () => void
    const slow = new Promise<void>(resolve => { release = resolve })
    const target = vi.fn(async () => { await slow; return true })
    tokenKeepAlive.registerTarget('slow', target)
    tokenKeepAlive.start()
    const first = vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    release()
    await first
    expect(target).toHaveBeenCalledTimes(1)
  })

  it('stop cancels both timers', async () => {
    const target = vi.fn(async () => true)
    tokenKeepAlive.registerTarget('x', target)
    tokenKeepAlive.start()
    tokenKeepAlive.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(target).not.toHaveBeenCalled()
  })
})
