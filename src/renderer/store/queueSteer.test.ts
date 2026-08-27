import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessage, useAppStore } from './index'

const sessionId = 'queue-steer-test'

const message = (id: string): QueuedMessage => ({ id, text: id })

beforeEach(() => {
  useAppStore.setState({
    queuedMessages: {
      [sessionId]: [message('Q1'), message('Q2'), message('Q3')]
    },
    steeringQueuedIds: {},
    busy: { [sessionId]: true }
  })
  vi.stubGlobal('window', {
    electronAPI: {
      getSessionState: vi.fn().mockResolvedValue(null),
      checkpointCreate: vi.fn().mockResolvedValue(null),
      sendMessage: vi.fn().mockResolvedValue(true)
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('queued Steer ownership', () => {
  it('keeps a reserved head in the queue until the ACK resolves', () => {
    expect(useAppStore.getState().reserveQueuedMessage(sessionId, 'Q1')).toBe(true)
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)).toBeUndefined()

    useAppStore.getState().releaseQueuedMessage(sessionId, 'Q1')
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)?.id).toBe('Q1')
    expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q2', 'Q3'])
  })

  it('preserves FIFO when a middle item is reserved and then fails', () => {
    expect(useAppStore.getState().reserveQueuedMessage(sessionId, 'Q2')).toBe(true)
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)?.id).toBe('Q1')
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)).toBeUndefined()

    useAppStore.getState().releaseQueuedMessage(sessionId, 'Q2')
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)?.id).toBe('Q2')
    expect(useAppStore.getState().shiftQueuedMessage(sessionId)?.id).toBe('Q3')
  })

  it('rejects a duplicate reservation for one queued item', () => {
    expect(useAppStore.getState().reserveQueuedMessage(sessionId, 'Q1')).toBe(true)
    expect(useAppStore.getState().reserveQueuedMessage(sessionId, 'Q1')).toBe(false)
    expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q1', 'Q2', 'Q3'])
  })

  it('clears stale queue-Steer feedback after normal dispatch succeeds', async () => {
    useAppStore.setState({
      queuedMessages: { [sessionId]: [message('Q1')] },
      sessionErrors: { [sessionId]: 'chat.steerQueueFailed' }
    })

    expect(useAppStore.getState().drainQueuedMessage(sessionId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAppStore.getState().sessionErrors[sessionId]).toBeUndefined()
  })

  it('lets a normal queue send failure replace queue-Steer feedback', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      electronAPI: {
        getSessionState: vi.fn().mockResolvedValue(null),
        checkpointCreate: vi.fn().mockResolvedValue(null),
        sendMessage
      }
    })
    useAppStore.setState({
      queuedMessages: { [sessionId]: [message('Q1')] },
      sessionErrors: { [sessionId]: 'chat.steerQueueFailed' }
    })

    expect(useAppStore.getState().drainQueuedMessage(sessionId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(useAppStore.getState().sessionErrors[sessionId]).toBe('chat.sendFailed')
  })

  it('does not clear a fatal session error during normal queue dispatch', async () => {
    useAppStore.setState({
      queuedMessages: { [sessionId]: [message('Q1')] },
      sessionErrors: { [sessionId]: 'chat.sessionDead' }
    })

    expect(useAppStore.getState().drainQueuedMessage(sessionId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAppStore.getState().sessionErrors[sessionId]).toBe('chat.sessionDead')
  })
})
