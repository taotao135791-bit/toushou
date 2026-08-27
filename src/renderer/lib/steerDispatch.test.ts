import { describe, expect, it, vi } from 'vitest'
import { dispatchSteer, steerFailureKey } from './steerDispatch'

const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' }

describe('dispatchSteer', () => {
  it('maps failure feedback to the interaction source', () => {
    expect(steerFailureKey('composer')).toBe('chat.steerComposerFailed')
    expect(steerFailureKey('queue')).toBe('chat.steerQueueFailed')
  })

  it('normalizes an accepted composer steer and forwards images', async () => {
    const steer = vi.fn().mockResolvedValue(true)

    const result = await dispatchSteer({
      sessionId: 'session-a',
      text: 'Focus on src',
      images: [image],
      source: 'composer',
      steer
    })

    expect(result).toEqual({ source: 'composer', ok: true })
    expect(steer).toHaveBeenCalledWith('session-a', 'Focus on src', [image])
  })

  it('keeps a false acknowledgement unsuccessful', async () => {
    const result = await dispatchSteer({
      sessionId: 'session-a',
      text: 'Focus on src',
      source: 'queue',
      steer: vi.fn().mockResolvedValue(false)
    })

    expect(result).toEqual({ source: 'queue', ok: false })
  })

  it('normalizes a rejected RPC without creating a success fact', async () => {
    const error = new Error('session closed')
    const result = await dispatchSteer({
      sessionId: 'session-a',
      text: 'Focus on src',
      source: 'queue',
      steer: vi.fn().mockRejectedValue(error)
    })

    expect(result).toEqual({ source: 'queue', ok: false, error })
  })
})
