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
      onReply: async (_route, content) => { replies.push(content) }, ownerOpenId: 'ou_owner'
    })
    await router.handleInbound(message())
    router.onSessionEvent({ type: 'message', sessionId: 'session-1', role: 'assistant', content: '第一段' })
    router.onSessionEvent({ type: 'message', sessionId: 'session-1', role: 'assistant', content: '第二段' })
    router.onSessionEvent({ type: 'status', sessionId: 'session-1', status: 'idle', isTerminal: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replies).toEqual(['第一段第二段'])
  })
})
