import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, flushStreamQueueForTest } from './index'

const sessionId = 'session-event-test'

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: { getSubagents: async () => null } })
})

afterEach(() => {
  flushStreamQueueForTest()
  useAppStore.setState({ messages: {}, executions: {}, sessions: [], resumeRecencySeeds: {}, compacting: {} })
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

describe('compaction rows in the conversation', () => {
  const current = () => useAppStore.getState().messages[sessionId] ?? []

  it.each(['compacted', 'skipped', 'aborted', 'failed'] as const)(
    'updates the original row on %s without disturbing adjacent streamed replies',
    outcome => {
      const { applySessionEvent: dispatch } = useAppStore.getState()
      dispatch({ type: 'message', sessionId, role: 'assistant', content: 'Earlier' })
      dispatch({ type: 'compaction', sessionId, phase: 'start', source: 'manual' })
      dispatch({ type: 'compaction', sessionId, phase: 'start', source: 'manual' })
      flushStreamQueueForTest()
      expect(current()).toHaveLength(2)
      const running = current()[1]
      expect(running).toMatchObject({ role: 'system', variant: 'info', compactionStatus: 'running', compactionSource: 'manual' })
      expect(useAppStore.getState().compacting[sessionId]).toBe(true)

      dispatch({ type: 'message', sessionId, role: 'assistant', content: 'Later' })
      dispatch({ type: 'compaction', sessionId, phase: 'end', outcome })
      dispatch({ type: 'compaction', sessionId, phase: 'end', outcome })
      flushStreamQueueForTest()
      expect(current()).toMatchObject([
        { content: 'Earlier' }, { id: running.id, compactionStatus: outcome, compactionSource: 'manual' }, { content: 'Later' }
      ])
      expect(current()[1].content).not.toEqual(running.content)
      expect(useAppStore.getState().compacting[sessionId]).toBe(false)
    }
  )

  it('settles a fatal interruption or a closed process, and handles separate auto runs independently', () => {
    const { applySessionEvent: dispatch } = useAppStore.getState()
    dispatch({ type: 'compaction', sessionId, phase: 'start' })
    dispatch({ type: 'compaction', sessionId, phase: 'end', outcome: 'compacted' })
    dispatch({ type: 'compaction', sessionId, phase: 'start' })
    dispatch({ type: 'error', sessionId, message: 'Child exited', recoverable: false })
    dispatch({ type: 'closed', sessionId })
    const other = 'another-process'
    dispatch({ type: 'compaction', sessionId: other, phase: 'start' })
    dispatch({ type: 'closed', sessionId: other })
    flushStreamQueueForTest()
    const rows = current().filter(row => row.compactionStatus)
    expect(rows.map(row => row.compactionStatus)).toEqual(['compacted','failed'])
    expect(rows.every(row => row.compactionSource === 'auto')).toBe(true)
    expect(rows[0].id).not.toBe(rows[1].id)
    expect(useAppStore.getState().messages[other]).toMatchObject([{ compactionStatus: 'aborted' }])
    expect(useAppStore.getState().compacting).toMatchObject({ [sessionId]: false, [other]: false })
  })

  it('reconciles a legacy completion without a start and ignores duplicate terminal notifications', () => {
    const { applySessionEvent: dispatch } = useAppStore.getState()
    dispatch({ type: 'compaction', sessionId, phase: 'end' })
    dispatch({ type: 'compaction', sessionId, phase: 'end' })
    dispatch({ type: 'closed', sessionId })
    flushStreamQueueForTest()
    expect(current()).toMatchObject([{ compactionSource: 'auto', compactionStatus: 'compacted' }])
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
