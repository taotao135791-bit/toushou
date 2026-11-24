import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, flushStreamQueueForTest } from './index'

const sessionId = 'session-event-test'

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: { getSubagents: async () => null } })
})

afterEach(() => {
  flushStreamQueueForTest()
  useAppStore.setState({ messages: {}, executions: {}, sessions: [], resumeRecencySeeds: {} })
  vi.unstubAllGlobals()
})

describe('session message events', () => {
  it('seals each completed assistant reply before the next streamed answer', () => {
    const store = useAppStore.getState()
    const sessionId = 'branch-replies'
    store.applySessionEvent({ type: 'message', sessionId, role: 'assistant', content: 'First' })
    store.applySessionEvent({ type: 'reply_completed', sessionId, replyKey: 'first' })
    store.applySessionEvent({ type: 'message', sessionId, role: 'assistant', content: 'Second' })
    store.applySessionEvent({ type: 'reply_completed', sessionId, replyKey: 'second' })
    flushStreamQueueForTest()
    expect(useAppStore.getState().messages[sessionId].map(row => [row.content, row.replyKey])).toEqual([
      ['First', 'first'], ['Second', 'second']
    ])
  })

  it('keeps system notices as quiet system messages', () => {
    useAppStore.getState().applySessionEvent({
      type: 'message',
      sessionId,
      role: 'system',
      variant: 'info',
      content: 'Extension UI was ignored.'
    })
    flushStreamQueueForTest()

    expect(useAppStore.getState().messages[sessionId]).toEqual([
      expect.objectContaining({
        role: 'system',
        variant: 'info',
        content: 'Extension UI was ignored.'
      })
    ])
  })

  it('flushes assistant content received before a provider error', () => {
    const { applySessionEvent } = useAppStore.getState()
    applySessionEvent({ type: 'message', sessionId, role: 'assistant', content: 'Partial reply' })
    applySessionEvent({ type: 'error', sessionId, message: 'Connection failed' })
    flushStreamQueueForTest()

    expect(useAppStore.getState().messages[sessionId]).toMatchObject([
      { role: 'assistant', content: 'Partial reply' },
      { role: 'system', content: 'Error: Connection failed' }
    ])
  })
})

describe('resume recency seeds (anti-bounce)', () => {
  it('orders the registry row at its seeded recency, not the spawn createdAt', () => {
    const state = useAppStore.getState()
    // Click stamped the durable uuid BEFORE the runtime registry push lands.
    state.seedResumeRecency('01a1f855-19ff-714a-bca8-779a36428097', 1738000000000)
    state.addSession({
      id: 'runtime-row',
      cwd: 'D:/工作/组内协作开发',
      title: 'WF 文案生成',
      // The registry push carries the spawn time — historically this floated
      // the row to the top for one frame (the visible bounce).
      createdAt: Date.now(),
      status: 'idle',
      resumeFrom: '/sessions/2026-11-20T09-41-29-215Z_01a1f855-19ff-714a-bca8-779a36428097.jsonl'
    }, false)
    const row = useAppStore.getState().sessions.find((session) => session.id === 'runtime-row')
    expect(row?.lastActivityAt).toBe(1738000000000)
  })

  it('keeps the previous activity stamp authoritative over any seed', () => {
    const state = useAppStore.getState()
    useAppStore.setState({ sessions: [{ id: 'known-row', cwd: 'D:/w', title: 'T', createdAt: 1, lastActivityAt: 42, status: 'idle' }] })
    state.seedResumeRecency('aaaaaaaa-0000-0000-0000-000000000001', 999)
    state.addSession({
      id: 'known-row',
      cwd: 'D:/w',
      title: 'T',
      createdAt: 2,
      resumeFrom: '/sessions/2026-01-01T00-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000001.jsonl',
      status: 'idle'
    }, false)
    expect(useAppStore.getState().sessions.find((session) => session.id === 'known-row')?.lastActivityAt).toBe(42)
  })
})
