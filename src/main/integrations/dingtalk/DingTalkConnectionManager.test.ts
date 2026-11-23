import { afterEach, describe, expect, it, vi } from 'vitest'
import { DingTalkConnectionManager } from './DingTalkConnectionManager'
import type { DingTalkConfiguration } from './DingTalkCredentialStore'
import { DingTalkStreamError, type DingTalkIncomingMessage, type DingTalkStream } from './DingTalkStream'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-dingtalk-fixture' }, safeStorage: {} }))
vi.mock('./DingTalkChat', () => ({ DingTalkChat: class {} }))

const credentials = { clientId: 'synthetic-application-1234', clientSecret: 'synthetic-app-secret' }
const owner = { senderId: 'synthetic-owner', conversationId: 'synthetic-private-chat' }
const paired = { ...credentials, owner }

function message(text: string, overrides: Partial<DingTalkIncomingMessage> = {}): DingTalkIncomingMessage {
  return {
    ...owner,
    id: 'synthetic-message',
    conversationType: 'direct',
    text,
    replyUrl: 'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',
    replyExpiresAt: Date.now() + 60_000,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

type ManagerDependencies = NonNullable<ConstructorParameters<typeof DingTalkConnectionManager>[0]>
type StreamCallbacks = Parameters<NonNullable<ManagerDependencies['createStream']>>[1]
type SaveConfiguration = NonNullable<ManagerDependencies['storage']>['save']

function fakeStream(configuration: DingTalkConfiguration, callbacks: StreamCallbacks) {
  return {
    configuration,
    callbacks,
    connect: vi.fn<DingTalkStream['connect']>().mockResolvedValue(undefined),
    close: vi.fn<DingTalkStream['close']>(),
    reply: vi.fn<DingTalkStream['reply']>().mockResolvedValue(undefined)
  }
}

const managers: DingTalkConnectionManager[] = []

function setup(initial: DingTalkConfiguration | null = null, configureStream?: (stream: ReturnType<typeof fakeStream>) => void) {
  let persisted = initial
  const storage = {
    load: vi.fn(async () => persisted && structuredClone(persisted)),
    save: vi.fn<SaveConfiguration>(async (configuration, _attempt, canCommit) => {
      if (canCommit && !canCommit()) return false
      persisted = structuredClone(configuration)
      return true
    }),
    clear: vi.fn(async () => { persisted = null })
  }
  const streams: ReturnType<typeof fakeStream>[] = []
  const createStream = vi.fn((configuration: DingTalkConfiguration, callbacks: StreamCallbacks) => {
    const stream = fakeStream(configuration, callbacks)
    configureStream?.(stream)
    streams.push(stream)
    return stream
  })
  const chat = {
    turn: vi.fn<NonNullable<ManagerDependencies['chat']>['turn']>().mockResolvedValue('已知消耗 100，点击 50。'),
    reset: vi.fn()
  }
  const manager = new DingTalkConnectionManager({ storage, createStream, chat })
  managers.push(manager)
  return { manager, streams, storage, chat }
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown()
  vi.useRealTimers()
})

describe('DingTalk private connection manager', () => {
  it('pairs only through a private pairing code and serves only the exact bound user and conversation', async () => {
    const { manager, streams, storage, chat } = setup()
    const result = await manager.connect(credentials)
    expect(result).toMatchObject({ ok: true, snapshot: { state: 'connected', status: 'waiting_for_user', paired: false, clientIdMasked: '••••1234' } })
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret)
    const code = result.snapshot.pairingCode
    expect(code).toMatch(/^[a-f0-9]{12}$/)
    const stream = streams[0]

    stream.callbacks.onMessage(message(`/pair ${code}`, { conversationType: 'group' }))
    stream.callbacks.onMessage(message('/pair wrong'))
    stream.callbacks.onMessage(message('查询今天投放表现'))
    expect(storage.save).toHaveBeenCalledOnce()
    expect(stream.reply).not.toHaveBeenCalled()
    expect(chat.turn).not.toHaveBeenCalled()

    stream.callbacks.onMessage(message(`/pair ${code}`))
    await vi.waitFor(() => expect(manager.getSnapshot()).toMatchObject({ paired: true, status: 'connected', pairingCode: undefined }))
    expect(await storage.load()).toEqual(paired)
    expect(stream.reply).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining('钉钉已绑定投手'), expect.any(AbortSignal))

    stream.reply.mockClear()
    stream.callbacks.onMessage(message('/ping', { senderId: 'outsider', senderIsAdmin: true }))
    stream.callbacks.onMessage(message('/ping', { conversationId: 'another-private-chat' }))
    stream.callbacks.onMessage(message('/ping', { conversationType: 'group' }))
    expect(stream.reply).not.toHaveBeenCalled()

    stream.callbacks.onMessage(message('/ping'))
    expect(stream.reply).toHaveBeenCalledWith(expect.objectContaining(owner), '投手连接正常。', expect.any(AbortSignal))
    expect(chat.turn).not.toHaveBeenCalled()

    const prompt = message('总结今天投放数据', { id: 'live-turn' })
    stream.callbacks.onMessage(prompt)
    stream.callbacks.onMessage(prompt)
    await vi.waitFor(() => expect(stream.reply).toHaveBeenCalledWith(prompt, '已知消耗 100，点击 50。', expect.any(AbortSignal)))
    expect(chat.turn).toHaveBeenCalledOnce()
    expect(chat.turn).toHaveBeenCalledWith(prompt.text, expect.any(AbortSignal))
  })

  it('recovers the saved pairing and opens a fresh stream ticket after a dropped socket', async () => {
    vi.useFakeTimers()
    const { manager, streams, storage } = setup(paired)
    await manager.initialize()
    await manager.initialize()
    expect(storage.load).toHaveBeenCalledOnce()
    expect(storage.save).not.toHaveBeenCalled()
    expect(manager.getSnapshot()).toMatchObject({ state: 'connected', paired: true, pairingCode: undefined })

    streams[0].callbacks.onMessage(message('/ping'))
    expect(streams[0].reply).toHaveBeenCalledOnce()
    streams[0].callbacks.onDisconnect()
    expect(manager.getSnapshot()).toMatchObject({ state: 'reconnecting', status: 'degraded', paired: true })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(streams).toHaveLength(2)
    expect(streams[1].configuration).toEqual(paired)
    expect(streams[1].connect).toHaveBeenCalledOnce()
    expect(manager.getSnapshot()).toMatchObject({ state: 'connected', paired: true })
    streams[0].callbacks.onMessage(message('/ping', { id: 'stale-event' }))
    streams[1].callbacks.onMessage(message('/ping'))
    expect(streams[0].reply).toHaveBeenCalledOnce()
    expect(streams[1].reply).not.toHaveBeenCalled()
    streams[1].callbacks.onMessage(message('/ping', { id: 'fresh-event' }))
    expect(streams[1].reply).toHaveBeenCalledOnce()
  })

  it('retains a verified connection and saved pairing when replacement credentials are rejected', async () => {
    const { manager, streams, storage } = setup(paired, stream => {
      if (stream.configuration.clientId === 'rejected-app') stream.connect.mockRejectedValue(new DingTalkStreamError('credentials'))
    })
    await manager.initialize()
    await expect(manager.connect({ clientId: 'rejected-app', clientSecret: 'a-secret' })).resolves.toMatchObject({
      ok: false, error: 'invalid-credentials', snapshot: { state: 'connected', paired: true, clientIdMasked: '••••1234' }
    })
    expect(storage.save).not.toHaveBeenCalled()
    expect(await storage.load()).toEqual(paired)
    expect(streams[0].close).not.toHaveBeenCalled()
    expect(streams[1].close).toHaveBeenCalledOnce()
    streams[0].callbacks.onMessage(message('/ping'))
    expect(streams[0].reply).toHaveBeenCalledOnce()
  })

  it('keeps the old app active and persisted when its replacement drops during credential save', async () => {
    const { manager, streams, storage } = setup(paired)
    await manager.initialize()
    const originalSave = storage.save.getMockImplementation()!
    const write = deferred<void>()
    storage.save.mockImplementationOnce(async (...args) => {
      await write.promise
      return originalSave(...args)
    })
    const replacement = manager.connect({ clientId: 'replacement-app', clientSecret: 'a-secret' })
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce())
    streams[1].callbacks.onDisconnect()
    write.resolve(undefined)

    await expect(replacement).resolves.toMatchObject({ ok: false, error: 'network', snapshot: { state: 'connected', paired: true } })
    expect(await storage.load()).toEqual(paired)
    expect(streams[0].close).not.toHaveBeenCalled()
    expect(streams[1].close).toHaveBeenCalledOnce()
  })

  it('cancels an in-progress handshake and removes the stored app on disconnect', async () => {
    const pending = deferred<void>()
    const { manager, streams, storage } = setup(null, stream => {
      stream.connect.mockImplementation(() => pending.promise)
      stream.close.mockImplementation(() => pending.reject(new DingTalkStreamError('cancelled')))
    })
    const connection = manager.connect(credentials)
    await vi.waitFor(() => expect(streams).toHaveLength(1))

    const disconnect = manager.disconnect()
    expect(streams[0].close).toHaveBeenCalled()
    await expect(connection).resolves.toMatchObject({ ok: false })
    await expect(disconnect).resolves.toMatchObject({ ok: true, snapshot: { state: 'idle', configured: false, paired: false } })
    expect(storage.save).not.toHaveBeenCalled()
    expect(storage.clear).toHaveBeenCalledOnce()
  })

  it('finishes disconnect after a pending pairing write without exposing or replying to the stale binding', async () => {
    const { manager, streams, storage, chat } = setup()
    const connection = await manager.connect(credentials)
    const originalSave = storage.save.getMockImplementation()!
    const write = deferred<void>()
    storage.save.mockImplementationOnce(async (...args) => {
      await write.promise
      return originalSave(...args)
    })
    streams[0].callbacks.onMessage(message(`/pair ${connection.snapshot.pairingCode}`))
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2))

    const disconnect = manager.disconnect()
    expect(manager.getSnapshot()).toMatchObject({ state: 'idle', pairingCode: undefined })
    write.resolve(undefined)
    await expect(disconnect).resolves.toMatchObject({ ok: true, snapshot: { configured: false, paired: false } })
    expect(await storage.load()).toBeNull()
    expect(streams[0].reply).not.toHaveBeenCalled()
    expect(chat.turn).not.toHaveBeenCalled()
  })
})
