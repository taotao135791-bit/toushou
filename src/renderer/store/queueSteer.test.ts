import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpMention } from '@shared/mcpMentions'
import { QueuedMessage, flushStreamQueueForTest, useAppStore } from './index'

const sessionId = 'queue-steer-test'

const message = (id: string): QueuedMessage => ({ id, text: id })

beforeEach(() => {
  useAppStore.setState({
    queuedMessages: {
      [sessionId]: [message('Q1'), message('Q2'), message('Q3')]
    },
    queueDispatching: {},
    queuePauseReasons: {},
    steeringQueuedIds: {},
    busy: { [sessionId]: false },
    sessions: [],
    sessionErrors: {},
    checkpointUnavailable: {},
    messages: {}
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
  it('keeps a reserved head in the queue until the ACK resolves', async () => {
    const store = useAppStore.getState()
    expect(store.reserveQueuedMessage(sessionId, 'Q1')).toBe(true)
    expect(store.drainQueuedMessage(sessionId)).toBe(false)
    expect(window.electronAPI.sendMessage).not.toHaveBeenCalled()

    store.releaseQueuedMessage(sessionId, 'Q1')
    expect(store.drainQueuedMessage(sessionId)).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q2', 'Q3']))
  })

  it('preserves FIFO when a middle item is reserved and then fails', async () => {
    const store = useAppStore.getState()
    const send = vi.mocked(window.electronAPI.sendMessage)
    expect(store.reserveQueuedMessage(sessionId, 'Q2')).toBe(true)
    expect(store.drainQueuedMessage(sessionId)).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q2', 'Q3']))
    store.setBusy(sessionId, false)
    expect(store.drainQueuedMessage(sessionId)).toBe(false)

    store.releaseQueuedMessage(sessionId, 'Q2')
    expect(store.drainQueuedMessage(sessionId)).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q3']))
    expect(send.mock.calls.map((call) => call[1])).toEqual(['Q1', 'Q2'])
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

  it('retains the failed head and FIFO tail until a deliberate retry', async () => {
    const sendMessage = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      electronAPI: {
        getSessionState: vi.fn().mockResolvedValue(null),
        checkpointCreate: vi.fn().mockResolvedValue(null),
        sendMessage
      }
    })
    const scopedPrompt = `${mcpMention('tiktok-ads')} 重查已选广告账户，日期仍按本轮范围。`
    useAppStore.setState({
      queuedMessages: { [sessionId]: [{ id: 'Q1', text: scopedPrompt }, message('Q2'), message('Q3')] },
      sessionErrors: { [sessionId]: 'chat.steerQueueFailed' }
    })

    expect(useAppStore.getState().drainQueuedMessage(sessionId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(useAppStore.getState().sessionErrors[sessionId]).toBe('chat.sendFailed')
    expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q1', 'Q2', 'Q3'])
    expect(useAppStore.getState().drainQueuedMessage(sessionId)).toBe(false)
    sendMessage.mockResolvedValue(true)
    expect(useAppStore.getState().resumeQueuedMessages(sessionId)).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().queuedMessages[sessionId].map((item) => item.id)).toEqual(['Q2', 'Q3']))
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([scopedPrompt, scopedPrompt])
    expect(useAppStore.getState().sessionErrors[sessionId]).toBeUndefined()
  })

  it('holds an IPC rejection without blindly repeating a potentially delivered prompt', async () => {
    const send = vi.mocked(window.electronAPI.sendMessage)
    send.mockRejectedValue(new Error('IPC acknowledgement lost'))
    const store = useAppStore.getState()
    expect(store.drainQueuedMessage(sessionId)).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().queuePauseReasons[sessionId]).toBe('unknown'))
    expect(useAppStore.getState().busy[sessionId]).toBe(false)
    expect(useAppStore.getState().queuedMessages[sessionId]).toHaveLength(3)
    store.applySessionEvent({ type: 'status', sessionId, status: 'working' })
    store.applySessionEvent({ type: 'status', sessionId, status: 'idle', isTerminal: true })
    expect(send).toHaveBeenCalledOnce()
  })

  it('captures the checkpoint before sending and honors Stop during the snapshot', async () => {
    let complete: () => void = () => {}
    const pending = new Promise<null>((resolve) => { complete = () => resolve(null) })
    const checkpoint = vi.mocked(window.electronAPI.checkpointCreate)
    checkpoint.mockReturnValueOnce(pending)
    const send = vi.mocked(window.electronAPI.sendMessage)
    const store = useAppStore.getState()
    expect(store.drainQueuedMessage(sessionId)).toBe(true)
    expect(checkpoint).toHaveBeenCalledWith(sessionId, 0, 'Q1')
    expect(send).not.toHaveBeenCalled()
    store.pauseQueuedMessages(sessionId, 'stopped')
    complete()
    await vi.waitFor(() => expect(useAppStore.getState().queueDispatching[sessionId]).toBeUndefined())
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().queuedMessages[sessionId]).toHaveLength(3)
    expect(store.resumeQueuedMessages(sessionId)).toBe(true)
    await vi.waitFor(() => expect(send.mock.calls).toEqual([[sessionId, 'Q1', undefined]]))
  })

  it('keeps the original project when restoring a closed session queue', () => {
    const store = useAppStore.getState()
    const source = { id: sessionId, cwd: '/synthetic/agency-a', title: 'Source', createdAt: 1, status: 'idle' as const }
    const sameProject = { ...source, id: 'new-a' }
    const otherProject = { ...source, id: 'new-b', cwd: '/synthetic/agency-b' }
    useAppStore.setState({ sessions: [source, sameProject, otherProject] })
    store.applySessionEvent({ type: 'closed', sessionId })
    expect(useAppStore.getState().queuePauseReasons[sessionId]).toBe('closed')
    expect(store.resumeQueuedMessages(sessionId)).toBe(false)
    expect(store.moveClosedQueue(sessionId, otherProject.id)).toBe(false)
    expect(store.moveClosedQueue(sessionId, sameProject.id)).toBe(true)
    expect(useAppStore.getState().queuedMessages[sameProject.id]).toHaveLength(3)
    expect(useAppStore.getState().queuePauseReasons[sameProject.id]).toBe('stopped')
    expect(window.electronAPI.sendMessage).not.toHaveBeenCalled()
  })

  it('drains the queued message inside the turn-end barrier without clobbering busy', async () => {
    // The turn-end barrier clears busy THEN drains; draining outside let the
    // async busy=false flush land after the next turn's busy=true (UI idle
    // while the queued turn ran) and left thinking unfinalized.
    vi.stubGlobal('window', {
      electronAPI: {
        getSessionState: vi.fn().mockResolvedValue(null),
        checkpointCreate: vi.fn().mockResolvedValue(null),
        sendMessage: vi.fn().mockResolvedValue(true)
      }
    })
    useAppStore.setState({
      currentSessionId: 'another-session',
      queuedMessages: { [sessionId]: [message('Q1')] }
    })
    useAppStore.getState().applySessionEvent({ type: 'status', sessionId, status: 'working' })
    useAppStore.getState().applySessionEvent({ type: 'status', sessionId, status: 'idle', isTerminal: true })
    flushStreamQueueForTest()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAppStore.getState().queuedMessages[sessionId]).toEqual([])
    expect((useAppStore.getState().messages[sessionId] || []).some((item) => item.role === 'user' && item.content === 'Q1')).toBe(true)
    // The drained turn keeps busy true — the turn-end clear must not win.
    expect(useAppStore.getState().busy[sessionId]).toBe(true)
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
