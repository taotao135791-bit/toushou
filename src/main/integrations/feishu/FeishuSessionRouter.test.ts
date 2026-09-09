import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../../../shared/types'
import { FeishuSessionRouter } from './FeishuSessionRouter'
import { NormalizedFeishuMessage } from './FeishuChannel'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function message(overrides: Partial<NormalizedFeishuMessage> = {}): NormalizedFeishuMessage {
  return {
    messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_owner',
    content: '分析今天的广告', mentionedBot: false, resources: [], createTime: Date.now(), ...overrides
  }
}

describe('FeishuSessionRouter', () => {
  it('enforces owner/mention policy, deduplicates events, and reuses chat threads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-router-'))
    dirs.push(dir)
    let nextId = 0
    const sessions = new Map<string, Session>()
    const createSession = vi.fn((_cwd, _onEvent, _opts) => {
      const session = { id: `session-${++nextId}`, cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const }
      sessions.set(session.id, session)
      return session
    })
    const sendMessage = vi.fn(() => true)
    const onReply = vi.fn(async () => undefined)
    const router = new FeishuSessionRouter({
      workspacePath: dir,
      routesFile: path.join(dir, 'routes.json'),
      createSession,
      sendMessage,
      getSession: (id) => sessions.get(id),
      getSessionState: async () => null,
      resumeSession: async () => null,
      killSession: vi.fn(() => true),
      onReply,
      ownerOpenId: 'ou_owner'
    })

    await router.handleInbound(message({ senderId: 'ou_other' }))
    await router.handleInbound(message({ messageId: 'om_group', chatType: 'group', mentionedBot: false }))
    // A group @mention from someone OTHER than the owner is refused too.
    await router.handleInbound(message({ messageId: 'om_group2', chatType: 'group', mentionedBot: true, senderId: 'ou_other' }))
    expect(createSession).not.toHaveBeenCalled()

    await router.handleInbound(message({ messageId: 'om_owner' }))
    await router.handleInbound(message())
    await router.handleInbound(message({ messageId: 'om_thread', rootId: 'om_root', threadId: 'omt_1' }))
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(router.listRoutes()).toHaveLength(2)
    expect(createSession.mock.calls[0]?.[2]).toEqual({ permissionMode: 'readonly' })
  })

  it('streams an assistant draft and replies when the OMP turn becomes idle', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'toushou-router-'))
    dirs.push(dir)
    const replies: string[] = []
    const router = new FeishuSessionRouter({
      workspacePath: dir, routesFile: path.join(dir, 'routes.json'),
      createSession: () => ({ id: 'session-1', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' }),
      sendMessage: () => true, getSession: () => ({ id: 'session-1', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' }),
      getSessionState: async () => null, resumeSession: async () => null, killSession: () => true,
      onReply: async (_route: unknown, content: string) => { replies.push(content) }, ownerOpenId: 'ou_owner'
    })
    await router.handleInbound(message())
    router.onSessionEvent({ type: 'message', sessionId: 'session-1', role: 'assistant', content: '第一段' })
    router.onSessionEvent({ type: 'message', sessionId: 'session-1', role: 'assistant', content: '第二段' })
    router.onSessionEvent({ type: 'status', sessionId: 'session-1', status: 'idle', isTerminal: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replies).toEqual(['第一段第二段'])
  })
})


describe('FeishuSessionRouter — resume & owner hardening', () => {
  function harness(overrides: Record<string, unknown> = {}) {
    const dir = path.join(os.tmpdir(), `toushou-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirs.push(dir)
    const createSession = vi.fn(() => ({
      id: 'session-new', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const
    }))
    const resumeSession = vi.fn(async () => null)
    const router = new FeishuSessionRouter({
      workspacePath: dir,
      routesFile: path.join(dir, 'routes.json'),
      createSession,
      sendMessage: () => true,
      getSession: () => undefined,
      getSessionState: async () => null,
      resumeSession,
      killSession: () => true,
      onReply: vi.fn(async () => undefined),
      ...overrides
    })
    return { router, createSession, resumeSession, dir }
  }

  it('learns the owner trust-on-first-use from the first direct message and persists the claim', async () => {
    const discovered: string[] = []
    const { router, createSession } = harness({
      ownerOpenId: undefined,
      onOwnerDiscovered: (openId: string) => discovered.push(openId)
    })
    await router.handleInbound(message({ senderId: 'ou_first' }))
    expect(discovered).toEqual(['ou_first'])
    // The discovering message itself is handled, not dropped.
    expect(createSession).toHaveBeenCalledTimes(1)
    // A different sender is now refused.
    await router.handleInbound(message({ messageId: 'om_2', senderId: 'ou_later' }))
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('passes readonly permission through the resume path', async () => {
    const dir = path.join(os.tmpdir(), `toushou-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirs.push(dir)
    const live = { id: 'session-1', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const }
    const resumeSession = vi.fn(
      async (
        _cwd: string,
        _onEvent: unknown,
        _filePath: string,
        _ctx: unknown,
        opts?: { permissionMode?: 'readonly' }
      ) => {
        void opts
        return null
      }
    )
    const router = new FeishuSessionRouter({
      workspacePath: dir, routesFile: path.join(dir, 'routes.json'),
      createSession: () => live,
      sendMessage: () => true,
      getSession: () => live,
      // The real router backfills the durable file from get_state.
      getSessionState: async () => ({ sessionFile: '/tmp/some-session.jsonl' }) as never,
      resumeSession: resumeSession as never,
      killSession: () => true,
      onReply: vi.fn(async () => undefined),
      ownerOpenId: 'ou_owner'
    })
    await router.handleInbound(message())
    // Let the async sessionFile backfill land.
    await new Promise((resolve) => setTimeout(resolve, 0))
    router.onSessionEvent({ type: 'closed', sessionId: 'session-1' })
    await router.handleInbound(message({ messageId: 'om_resume' }))
    expect(resumeSession).toHaveBeenCalledTimes(1)
    const resumeArgs = resumeSession.mock.calls[0]
    expect(resumeArgs[4]).toEqual({ permissionMode: 'readonly' })
  })

  it('a resume that throws degrades to a fresh session and drops the dead file reference', async () => {
    const dir = path.join(os.tmpdir(), `toushou-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirs.push(dir)
    const live = { id: 'session-1', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const }
    const fresh = { id: 'session-2', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const }
    const resumeSession = vi.fn(async () => {
      throw new Error('resumed session returned an empty transcript for a non-empty session file')
    })
    const createSession = vi.fn((_cwd: string, _onEvent: unknown, _opts: unknown, _ctx: unknown) =>
      createSession.mock.calls.length === 1 ? live : fresh
    )
    const router = new FeishuSessionRouter({
      workspacePath: dir, routesFile: path.join(dir, 'routes.json'),
      createSession: createSession as never,
      sendMessage: () => true,
      getSession: (id: string) => (id === 'session-1' ? live : fresh),
      // The fresh session's real state would carry a NEW file path; returning
      // null keeps the dropped reference visible in the assertion.
      getSessionState: async (id: string) =>
        id === 'session-1' ? (({ sessionFile: '/tmp/gone.jsonl' }) as never) : null,
      resumeSession,
      killSession: () => true,
      onReply: vi.fn(async () => undefined),
      ownerOpenId: 'ou_owner'
    })
    await router.handleInbound(message())
    await new Promise((resolve) => setTimeout(resolve, 0))
    router.onSessionEvent({ type: 'closed', sessionId: 'session-1' })

    await router.handleInbound(message({ messageId: 'om_2' }))
    expect(resumeSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(router.listRoutes()[0].sessionFile).toBeUndefined()
  })

  it('replies to the message that started the turn, not the latest one', async () => {
    const replies: Array<{ content: string; id: string }> = []
    const dir = path.join(os.tmpdir(), `toushou-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirs.push(dir)
    const live = { id: 'session-1', cwd: dir, title: 'Feishu', createdAt: Date.now(), status: 'idle' as const }
    const router = new FeishuSessionRouter({
      workspacePath: dir, routesFile: path.join(dir, 'routes.json'),
      createSession: () => live,
      sendMessage: () => true,
      getSession: () => live,
      getSessionState: async () => null,
      resumeSession: async () => null,
      killSession: () => true,
      onReply: async (_route, content, sourceMessageId) => { replies.push({ content, id: sourceMessageId }) },
      ownerOpenId: 'ou_owner'
    })
    await router.handleInbound(message({ messageId: 'om_start' }))
    router.onSessionEvent({ type: 'message', sessionId: 'session-1', role: 'assistant', content: '回答' })
    // A second message lands while the turn is still running…
    await router.handleInbound(message({ messageId: 'om_followup' }))
    router.onSessionEvent({ type: 'status', sessionId: 'session-1', status: 'idle', isTerminal: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The follow-up steers the SAME turn, so the combined answer threads
    // under the newest message — never an unrelated older one.
    expect(replies[0]).toEqual({ content: '回答', id: 'om_followup' })
  })

  it('unparseable messages get an explicit reply instead of analysis silence', async () => {
    const replies: string[] = []
    const { router } = harness({
      ownerOpenId: 'ou_owner',
      onReply: async (_route: unknown, content: string) => { replies.push(content) }
    })
    await router.handleInbound(message({ content: '' }))
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('看不懂')
  })
})
