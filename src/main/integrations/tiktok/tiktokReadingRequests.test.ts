import { describe, expect, it, vi } from 'vitest'
import { TikTokReadingRequests } from './tiktokReadingRequests'

describe('reading request isolation', () => {
  it('emits one account result only to the owning request', async () => {
    const requests = new TikTokReadingRequests()
    const ownerOne = vi.fn(), ownerTwo = vi.fn()
    const today = { account: { advertiserId: '1', name: null, currency: null, error: 'api' as const }, range: 'last7' as const, window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: { start: '2025-12-25', end: '2025-12-31' }, source: 'oauth' as const, generatedAt: 1 }
    await requests.run(2, 'request-other', async () => undefined, ownerTwo)
    await requests.run(1, 'request-one', async deps => { deps.onProgress?.({ completed: 1, total: 2, succeeded: 0, today }) }, ownerOne)
    expect(ownerOne).toHaveBeenCalledWith({ requestId: 'request-one', completed: 1, total: 2, succeeded: 0, today })
    expect(ownerTwo).not.toHaveBeenCalled()
  })
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
