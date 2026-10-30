import { describe, expect, it, vi } from 'vitest'
import { retryFailedMessage } from './retryMessage'
import type { MessageLike } from '../store'

const message: MessageLike = { id: 'old', role: 'user', content: '原消息\n@file.txt', failed: true, images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }] }
function harness(overrides: Partial<Parameters<typeof retryFailedMessage>[2]> = {}) {
  return { currentSessionId: 's', busy: false, enqueue: vi.fn(), send: vi.fn().mockResolvedValue(true), createId: () => 'queued-id', ...overrides }
}
describe('retryFailedMessage', () => {
  it('replays the original text and images while leaving unrelated draft state untouched', async () => {
    const draft = { text: 'private unfinished draft', images: [{ data: 'b3RoZXI=', mimeType: 'image/jpeg' }] }
    const saved = structuredClone(draft)
    const deps = harness()
    expect(await retryFailedMessage('s', message, deps)).toBe(true)
    expect(deps.send).toHaveBeenCalledOnce()
    expect(deps.send).toHaveBeenCalledWith('原消息\n@file.txt', [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }])
    expect(draft).toEqual(saved)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })
  it('queues the original payload when a turn is busy', async () => {
    const deps = harness({ busy: true })
    expect(await retryFailedMessage('s', message, deps)).toBe(true)
    expect(deps.send).not.toHaveBeenCalled()
    expect(deps.enqueue).toHaveBeenCalledWith('s', { id: 'queued-id', text: message.content, images: [{ type: 'image', ...message.images![0] }] })
  })
  it('does not send to another session or retry a non-failed message', async () => {
    const deps = harness({ currentSessionId: 'different' })
    expect(await retryFailedMessage('s', message, deps)).toBe(false)
    expect(await retryFailedMessage('s', { ...message, failed: false }, harness())).toBe(false)
    expect(deps.send).not.toHaveBeenCalled()
  })
})
