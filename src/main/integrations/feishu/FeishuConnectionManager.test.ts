import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionState } from '../../../shared/types'
import { NormalizedFeishuMessage } from './FeishuChannel'

// FeishuConnectionManager touches electron (paths, windows) and Main's live
// omp registry; both are stubbed so the test only exercises routing + sinks.
const paths = vi.hoisted(() => ({ documents: '', userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (key: string) => paths[key as keyof typeof paths] ?? '/tmp/toushou-feishu-fallback' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() }
}))

vi.mock('../../omp', () => ({
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  sendMessage: vi.fn(() => true),
  getSession: vi.fn(),
  getSessionState: vi.fn(async () => null),
  killSession: vi.fn(() => true)
}))

vi.mock('../../store', () => ({
  getStore: vi.fn(() => true),
  rememberRecentProject: vi.fn()
}))

import { createSession, getSession, getSessionState, resumeSession } from '../../omp'
import { FeishuConnectionManager } from './FeishuConnectionManager'

interface RouterAccess {
  router: {
    setOwnerOpenId(ownerOpenId: string): void
    handleInbound(message: NormalizedFeishuMessage): Promise<void>
  }
}

function message(overrides: Partial<NormalizedFeishuMessage> = {}): NormalizedFeishuMessage {
  return {
    messageId: 'om_1', chatId: 'oc_p2p', chatType: 'p2p', senderId: 'ou_owner',
    content: '分析今天的广告', mentionedBot: false, resources: [], createTime: Date.now(), ...overrides
  }
}

function session(id: string, createdAt: number): Session {
  return { id, cwd: path.join(paths.documents, '投手工作区'), title: '投手工作区', createdAt, status: 'idle' }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

beforeEach(async () => {
  paths.documents = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-docs-'))
  paths.userData = await mkdtemp(path.join(os.tmpdir(), 'toushou-feishu-user-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all([paths.documents, paths.userData].map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FeishuConnectionManager external session announcements', () => {
  it('emits a descriptor on session create, per chat type', async () => {
    const manager = new FeishuConnectionManager()
    const sink = vi.fn()
    manager.setExternalSessionSink(sink)
    const internal = manager as unknown as RouterAccess
    internal.router.setOwnerOpenId('ou_owner')

    // The omp-level createSession never sees the route ctx (the manager
    // wrapper consumes it); identify sessions by invocation order instead.
    let call = 0
    vi.mocked(createSession).mockImplementation(() => {
      call += 1
      return session(call === 1 ? 'session-p2p' : 'session-group', call === 1 ? 111 : 222)
    })
    vi.mocked(getSession).mockImplementation((id) => session(id, 0))

    await internal.router.handleInbound(message())
    await internal.router.handleInbound(
      message({ messageId: 'om_2', chatId: 'oc_group', chatType: 'group', senderId: 'ou_someone', mentionedBot: true })
    )

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-p2p',
      workspacePath: path.join(paths.documents, '投手工作区'),
      origin: 'feishu',
      chatType: 'p2p',
      suggestedTitle: '飞书私聊',
      createdAt: 111
    })
    expect(sink).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-group',
      workspacePath: path.join(paths.documents, '投手工作区'),
      origin: 'feishu',
      chatType: 'group',
      suggestedTitle: '飞书群聊',
      createdAt: 222
    })
    // The router still downgrades channel sessions to readonly tool access,
    // and the group route's chatType reached the manager wrapper (proven by
    // the second descriptor's chatType/suggestedTitle above).
    expect(vi.mocked(createSession).mock.calls[0]?.[2]).toEqual({ permissionMode: 'readonly' })
  })

  it('emits a descriptor when a dead route session is resumed from its file', async () => {
    const manager = new FeishuConnectionManager()
    const sink = vi.fn()
    manager.setExternalSessionSink(sink)
    const internal = manager as unknown as RouterAccess
    internal.router.setOwnerOpenId('ou_owner')

    const sessionFile = path.join(paths.userData, '123_abcd1234-0000-4000-8000-000000000000.jsonl')
    vi.mocked(createSession).mockReturnValue(session('session-1', 111))
    vi.mocked(getSessionState).mockResolvedValue({
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      sessionId: 'session-1',
      sessionFile,
      messageCount: 2,
      thinkingLevel: 'high'
    } as SessionState)
    vi.mocked(getSession).mockReturnValue(session('session-1', 111))

    await internal.router.handleInbound(message())
    // The session file is backfilled asynchronously after the handshake.
    await tick()

    // The runtime session is gone; the route resumes from its durable file.
    vi.mocked(getSession).mockReturnValue(undefined)
    const resumed = session('session-2', 333)
    vi.mocked(resumeSession).mockResolvedValue({ session: resumed, messages: [], historicalAgents: [] })

    await internal.router.handleInbound(message({ messageId: 'om_next' }))
    await tick()

    expect(vi.mocked(resumeSession)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resumeSession).mock.calls[0]?.[2]).toBe(sessionFile)
    // The route's chatType reached the descriptor (proving the ctx handoff
    // router → wrapper → emitExternalSession).
    expect(sink).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-2', chatType: 'p2p', suggestedTitle: '飞书私聊', createdAt: 333 })
    )
  })

  it('stays silent when session creation fails', async () => {
    const manager = new FeishuConnectionManager()
    const sink = vi.fn()
    manager.setExternalSessionSink(sink)
    const internal = manager as unknown as RouterAccess
    internal.router.setOwnerOpenId('ou_owner')

    vi.mocked(createSession).mockReturnValue({
      id: 'session-err',
      cwd: paths.documents,
      title: 'Missing folder',
      createdAt: 1,
      status: 'error'
    })

    await internal.router.handleInbound(message())
    expect(sink).not.toHaveBeenCalled()
  })
})
