import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessage, ExternalSessionDescriptor } from '@shared/types'
import { useAppStore } from './index'

const workspacePath = '/Users/tester/Documents/投手工作区'
const sessionId = 'session-feishu-1'

function descriptor(overrides: Partial<ExternalSessionDescriptor> = {}): ExternalSessionDescriptor {
  return {
    sessionId,
    workspacePath,
    origin: 'feishu',
    chatType: 'p2p',
    suggestedTitle: '飞书私聊',
    createdAt: 1000,
    ...overrides
  }
}

function stubApi(extra: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getSessionState: vi.fn().mockResolvedValue(null),
    getSubagents: vi.fn().mockResolvedValue(null),
    ...extra
  }
  vi.stubGlobal('window', { electronAPI: api })
  return api
}

beforeEach(() => {
  useAppStore.setState({
    sessions: [],
    sessionRecords: [],
    currentSessionId: null,
    messages: {},
    busy: {},
    unreadSessionIds: {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registerExternalSession', () => {
  it('registers a live foreign-workspace row and is idempotent across resumes', () => {
    stubApi()
    useAppStore.getState().registerExternalSession(descriptor())
    useAppStore.getState().registerExternalSession(descriptor())

    const { sessions, sessionRecords } = useAppStore.getState()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      cwd: workspacePath,
      title: '飞书私聊',
      origin: 'feishu',
      remoteReadonly: true,
      status: 'idle',
      createdAt: 1000
    })
    expect(sessionRecords).toHaveLength(1)
    expect(sessionRecords[0]).toMatchObject({
      runtimeSessionId: sessionId,
      workspaceRealPath: workspacePath,
      title: '飞书私聊',
      isLive: true
    })
  })

  it('uses the group suggested title and never overrides a rename', () => {
    stubApi()
    useAppStore.getState().registerExternalSession(
      descriptor({ sessionId: 'session-group', chatType: 'group', suggestedTitle: '飞书群聊' })
    )
    expect(useAppStore.getState().sessions.find((s) => s.id === 'session-group')?.title).toBe('飞书群聊')

    useAppStore.getState().setSessionTitle('session-group', '预算讨论')
    // A later descriptor (channel resume on the next Feishu message) fires again.
    useAppStore.getState().registerExternalSession(
      descriptor({ sessionId: 'session-group', chatType: 'group', suggestedTitle: '飞书群聊' })
    )
    expect(useAppStore.getState().sessions.find((s) => s.id === 'session-group')?.title).toBe('预算讨论')
  })

  it('keeps origin, readonly marker and title when Main re-reports the session', () => {
    stubApi()
    useAppStore.getState().registerExternalSession(descriptor())
    // Main's live registry re-reports the bare runtime Session (no origin,
    // project-dir title). The registered metadata must survive the merge.
    useAppStore.getState().addSession(
      { id: sessionId, cwd: workspacePath, title: '投手工作区', createdAt: 1000, status: 'idle' },
      false
    )
    expect(useAppStore.getState().sessions[0]).toMatchObject({
      id: sessionId,
      origin: 'feishu',
      remoteReadonly: true,
      title: '飞书私聊'
    })
  })

  it('marks a background Feishu session unread when its turn finishes elsewhere', () => {
    stubApi()
    useAppStore.getState().registerExternalSession(descriptor())
    useAppStore.setState({ currentSessionId: 'session-other' })

    useAppStore.getState().applySessionEvent({ type: 'status', sessionId, status: 'working' })
    expect(useAppStore.getState().busy[sessionId]).toBe(true)
    useAppStore.getState().applySessionEvent({ type: 'status', sessionId, status: 'idle', isTerminal: true })

    expect(useAppStore.getState().unreadSessionIds[sessionId]).toBe(true)
  })
})

describe('Feishu transcript backfill on open', () => {
  it('keeps the streamed tail through a mid-fetch turn and fetches once per session', async () => {
    let resolveTranscript!: (messages: ChatMessage[]) => void
    const api = stubApi({
      sessionTranscript: vi.fn(
        () => new Promise<ChatMessage[]>((resolve) => { resolveTranscript = resolve })
      )
    })
    useAppStore.getState().registerExternalSession(descriptor())

    // The conversation happened in Feishu before the user opened the app row.
    useAppStore.getState().applySessionEvent({ type: 'message', sessionId, role: 'user', content: '分析今天的投放' })
    useAppStore.getState().applySessionEvent({ type: 'message', sessionId, role: 'assistant', content: '好的，正在' })

    useAppStore.getState().setCurrentSessionId(sessionId)
    // Streaming continues while the transcript fetch is in flight: the fold
    // appends to the SAME in-flight assistant message.
    useAppStore
      .getState()
      .applySessionEvent({ type: 'message', sessionId, role: 'assistant', content: '分析今天的投放数据…' })

    resolveTranscript([
      { id: 'f1', role: 'user', content: '分析今天的投放' },
      { id: 'f2', role: 'assistant', content: '好的，正在分析今天的投放数据…（快照全文）' }
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useAppStore.getState().messages[sessionId]
    // The streamed tail is kept (deltas after the fetch append to it — a
    // snapshot replace would carve a gap), aligned with the durable copy.
    expect(messages).toHaveLength(2)
    expect(messages?.[0]).toMatchObject({ role: 'user', content: '分析今天的投放' })
    expect(messages?.[1]).toMatchObject({ role: 'assistant', content: '好的，正在分析今天的投放数据…' })

    // Re-selecting the session must not refetch (one backfill per app run).
    useAppStore.getState().setCurrentSessionId(null)
    useAppStore.getState().setCurrentSessionId(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.sessionTranscript).toHaveBeenCalledTimes(1)
  })

  it('prepends durable history the store missed (renderer attached mid-conversation)', async () => {
    const lateId = 'session-feishu-late'
    stubApi({
      sessionTranscript: vi.fn().mockResolvedValue([
        { id: 'h1', role: 'user', content: '窗口重载前的问题' },
        { id: 'h2', role: 'assistant', content: '窗口重载前的回答' },
        { id: 'u1', role: 'user', content: '新问题' }
      ] as ChatMessage[])
    })
    useAppStore.getState().registerExternalSession(descriptor({ sessionId: lateId }))
    // This window only ever folded the newest turn.
    useAppStore.getState().applySessionEvent({ type: 'message', sessionId: lateId, role: 'user', content: '新问题' })

    useAppStore.getState().setCurrentSessionId(lateId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useAppStore.getState().messages[lateId]
    expect(messages).toHaveLength(3)
    expect(messages?.[0]).toMatchObject({ role: 'user', content: '窗口重载前的问题' })
    expect(messages?.[1]).toMatchObject({ role: 'assistant', content: '窗口重载前的回答' })
    expect(messages?.[2]).toMatchObject({ role: 'user', content: '新问题' })
  })

  it('keeps the streamed tail when the fetch carries nothing new', async () => {
    const emptyId = 'session-feishu-empty'
    stubApi({ sessionTranscript: vi.fn().mockResolvedValue([]) })
    useAppStore.getState().registerExternalSession(descriptor({ sessionId: emptyId }))
    useAppStore.getState().applySessionEvent({ type: 'message', sessionId: emptyId, role: 'user', content: '只在此窗口可见' })

    useAppStore.getState().setCurrentSessionId(emptyId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAppStore.getState().messages[emptyId]).toHaveLength(1)
  })

  it('never fetches for sessions the GUI created itself', async () => {
    const api = stubApi()
    useAppStore.getState().addSession({
      id: 'session-local',
      cwd: '/tmp/project',
      title: 'project',
      createdAt: 1,
      status: 'idle'
    })
    useAppStore.getState().setCurrentSessionId('session-local')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.sessionTranscript).toBeUndefined()
  })
})
