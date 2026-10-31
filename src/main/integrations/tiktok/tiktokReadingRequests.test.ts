import { describe, expect, it, vi } from 'vitest'
import { TikTokReadingRequests } from './tiktokReadingRequests'

describe('reading request isolation', () => {
  it('scopes progress and cancellation to the owner and removes completed requests', async () => {
    const requests = new TikTokReadingRequests()
    const emit = vi.fn()
    let signal: AbortSignal | undefined
    let finish!: () => void
    const pending = requests.run(1, 'request-1', async deps => {
      signal = deps.signal
      deps.onProgress?.({ completed: 2, total: 21, succeeded: 1 })
      await new Promise<void>(resolve => { finish = resolve })
      return { cancelled: signal?.aborted }
    }, emit)
    expect(emit).toHaveBeenCalledWith({ requestId: 'request-1', completed: 2, total: 21, succeeded: 1 })
    expect(requests.cancel(2, 'request-1')).toBe(false)
    expect(signal?.aborted).toBe(false)
    expect(requests.cancel(1, 'request-1')).toBe(true)
    finish()
    expect(await pending).toEqual({ cancelled: true })
    expect(requests.cancel(1, 'request-1')).toBe(false)
  })
  it('rejects invalid or duplicate IDs and limits concurrent requests per owner', async () => {
    const requests = new TikTokReadingRequests()
    const finishers: Array<() => void> = []
    const work = () => new Promise<void>(resolve => { finishers.push(resolve) })
    const emit = vi.fn()
    const pending = [1, 2, 3, 4].map(i => requests.run(1, `id-${i}`, work, emit))
    expect(await requests.run(1, 'id-1', work, emit)).toEqual({ ok: false, error: 'invalid-input' })
    expect(await requests.run(1, 'id-5', work, emit)).toEqual({ ok: false, error: 'invalid-input' })
    expect(await requests.run(2, 'bad id', work, emit)).toEqual({ ok: false, error: 'invalid-input' })
    finishers.forEach(finish => finish())
    await Promise.all(pending)
  })
  it('does not claim cancellation after a completed scope starts committing', async () => {
    const requests = new TikTokReadingRequests()
    let finish!: () => void
    const pending = requests.run(1, 'commit', async deps => {
      deps.onCommitting?.()
      await new Promise<void>(resolve => { finish = resolve })
      return { saved: true, aborted: deps.signal?.aborted }
    }, () => {})
    expect(requests.cancel(1, 'commit')).toBe(false)
    finish()
    expect(await pending).toEqual({ saved: true, aborted: false })
  })
})
