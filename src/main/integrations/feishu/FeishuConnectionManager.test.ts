import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionState } from '../../../shared/types'
import { NormalizedFeishuMessage } from './FeishuChannel'

// FeishuConnectionManager touches electron (paths, windows) and Main's live
// omp registry; both are stubbed so the test only exercises routing + sinks.
const paths = vi.hoisted(() => ({ documents: '', userData: '' }))
const secureStorage = vi.hoisted(() => ({ isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn((value: string): Buffer => Buffer.from(value)), decryptString: vi.fn((_value: Buffer): string => '') }))

vi.mock('electron', () => ({
  app: { getPath: (key: string) => paths[key as keyof typeof paths] ?? '/tmp/toushou-feishu-fallback' },
  safeStorage: secureStorage,
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
import { secureStorageCoordinator } from '../secureStorageCoordinator'

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
  // The application singleton deliberately survives manager instances. Reset
  // it between isolated tests with a synthetic backend, never the Keychain.
  secureStorageCoordinator.encrypt({ isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }, 'fixture', { retry: true, retryEpoch: secureStorageCoordinator.blockedEpoch() })
})

describe('Feishu credential recovery', () => {
  it('reports unreadable credentials, blocks replacement and retries only on user action', async () => {
    const file = path.join(paths.userData, 'feishu-credentials.bin')
    await writeFile(file, 'unreadable-envelope')
    const manager = new FeishuConnectionManager()
    await manager.initialize()
    expect(manager.getSnapshot()).toMatchObject({ status: 'failed', lastError: expect.stringContaining('原数据已保留') })
    expect(secureStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1)
    await manager.beginPermissionRepair()
    const manual = await manager.connectManual({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' })
    expect(manual).toMatchObject({ ok: false, error: expect.stringContaining('原数据已保留') })
    expect(secureStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1)
    expect(await readFile(file, 'utf8')).toBe('unreadable-envelope')
    const retry = await manager.beginConnection()
    expect(retry).toMatchObject({ ok: false, error: expect.stringContaining('原数据已保留') })
    expect(secureStorage.isEncryptionAvailable).toHaveBeenCalledTimes(2)
    expect(await readFile(file, 'utf8')).toBe('unreadable-envelope')
  })
  it('restores the old connection after an explicit successful retry', async () => {
    const file = path.join(paths.userData, 'feishu-credentials.bin')
    await writeFile(file, 'ZW5jcnlwdGVk')
    secureStorage.isEncryptionAvailable.mockReturnValueOnce(false).mockReturnValue(true)
    secureStorage.decryptString.mockReturnValue(JSON.stringify({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' }))
    const manager = new FeishuConnectionManager()
    const connect = vi.spyOn(manager as unknown as { connectCredentials: (credentials: unknown) => Promise<void> }, 'connectCredentials').mockResolvedValue(undefined)
    try {
      await manager.initialize()
      expect(manager.getSnapshot().status).toBe('failed')
      expect(await manager.beginConnection()).toMatchObject({ ok: true })
      expect(connect).toHaveBeenCalledOnce()
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_test' }))
      expect(await readFile(file, 'utf8')).toBe('ZW5jcnlwdGVk')
    } finally {
      await manager.disconnect()
      secureStorage.isEncryptionAvailable.mockReturnValue(false)
    }
  })
  it('allows an explicit manual first connection to recover a shared storage lock', async () => {
    expect(() => secureStorageCoordinator.encrypt({ isAvailable: () => false, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }, 'fixture')).toThrow()
    secureStorage.isEncryptionAvailable.mockReturnValue(true)
    const manager = new FeishuConnectionManager()
    const connect = vi.spyOn(manager as unknown as { connectCredentials: (credentials: unknown) => Promise<void> }, 'connectCredentials').mockResolvedValue(undefined)
    try {
      const result = await manager.connectManual({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' })
      expect(result).toMatchObject({ ok: true })
      expect(connect).toHaveBeenCalledOnce()
      expect(secureStorage.isEncryptionAvailable).toHaveBeenCalledOnce()
      expect(secureStorageCoordinator.isBlocked()).toBe(false)
      expect(await readFile(path.join(paths.userData, 'feishu-credentials.bin'), 'utf8')).not.toContain('secret-value')
    } finally {
      await manager.disconnect()
      secureStorage.isEncryptionAvailable.mockReturnValue(false)
    }
  })
  it.each([false, true])('does not retry a new failure that appears after manual connection starts (initially blocked: %s)', async (initiallyBlocked) => {
    const fail = { isAvailable: () => false, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const success = { ...fail, isAvailable: () => true }
    if (initiallyBlocked) expect(() => secureStorageCoordinator.encrypt(fail, 'fixture')).toThrow()
    secureStorage.isEncryptionAvailable.mockReturnValue(true)
    const manager = new FeishuConnectionManager()
    vi.spyOn(manager as unknown as { connectCredentials: (credentials: unknown) => Promise<void> }, 'connectCredentials').mockImplementation(async () => {
      if (initiallyBlocked) secureStorageCoordinator.encrypt(success, 'fixture', { retry: true, retryEpoch: secureStorageCoordinator.blockedEpoch() })
      expect(() => secureStorageCoordinator.encrypt(fail, 'fixture')).toThrow()
    })
    try {
      const result = await manager.connectManual({ appId: 'cli_test', appSecret: 'secret-value', brand: 'feishu' })
      expect(result).toMatchObject({ ok: false })
      expect(secureStorage.isEncryptionAvailable).not.toHaveBeenCalled()
      await expect(readFile(path.join(paths.userData, 'feishu-credentials.bin'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await manager.disconnect()
      secureStorage.isEncryptionAvailable.mockReturnValue(false)
    }
  })
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

    // Non-owner group @mentions are refused (injection defence)…
    await internal.router.handleInbound(
      message({ messageId: 'om_0', chatId: 'oc_group', chatType: 'group', senderId: 'ou_someone', mentionedBot: true })
    )
    expect(sink).not.toHaveBeenCalled()

    await internal.router.handleInbound(message())
    await internal.router.handleInbound(
      message({ messageId: 'om_2', chatId: 'oc_group', chatType: 'group', senderId: 'ou_owner', mentionedBot: true })
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
    expect(vi.mocked(createSession).mock.calls[0]?.[2]).toEqual({
      permissionMode: 'readonly',
      origin: 'feishu'
    })
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

describe('FeishuConnectionManager auth-gap guidance', () => {
  it('pushes an auth notice when a tool call is refused for authorization', async () => {
    const manager = new FeishuConnectionManager()
    const sink = vi.fn()
    manager.setAuthGapSink(sink)

    // The capability gate fires before the channel check: with only the
    // default 'messaging' capability authorized, doc_read is refused with an
    // authorizationRequired result — exactly the deterministic guidance path.
    const result = await manager.executeTool('session-1', { action: 'doc_read', documentId: 'doc_1' })
    expect(result.authorizationRequired).toBe('docs.read')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('session-1', { kind: 'auth', capability: 'docs.read' })
  })

  it('pushes a paused notice once the breaker trips (after repeated refusals)', async () => {
    const manager = new FeishuConnectionManager()
    const sink = vi.fn()
    manager.setAuthGapSink(sink)

    // Five hard failures open the breaker; calls 1-5 carry the auth notice.
    for (let i = 0; i < 5; i++) {
      await manager.executeTool('session-2', { action: 'doc_read', documentId: 'doc_1' })
    }
    expect(sink).toHaveBeenCalledTimes(5)
    expect(sink).toHaveBeenLastCalledWith('session-2', { kind: 'auth', capability: 'docs.read' })

    // The sixth call is refused by the open breaker — no authorization field,
    // so the paused notice explains why calls stopped.
    await manager.executeTool('session-2', { action: 'doc_read', documentId: 'doc_1' })
    expect(sink).toHaveBeenCalledTimes(6)
    expect(sink).toHaveBeenLastCalledWith('session-2', { kind: 'paused' })
  })
})
