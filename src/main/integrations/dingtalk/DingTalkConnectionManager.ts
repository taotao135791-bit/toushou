import { randomBytes } from 'node:crypto'
import type {
  ConnectionDefinition,
  ConnectionStatus,
  DingTalkConnectionError,
  DingTalkConnectionResult,
  DingTalkConnectionSnapshot,
  DingTalkConnectionState
} from '../../../shared/connections'
import { secureStorageCoordinator } from '../secureStorageCoordinator'
import { DingTalkChat } from './DingTalkChat'
import { DingTalkCredentialStore, type DingTalkConfiguration, parseDingTalkCredentials } from './DingTalkCredentialStore'
import { DingTalkStream, DingTalkStreamError, type DingTalkIncomingMessage } from './DingTalkStream'

export const DINGTALK_SETUP_URL = 'https://open-dev.dingtalk.com/'
export const DINGTALK_GUIDE_URL = 'https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/python/create-bot/'

const definition: ConnectionDefinition = {
  id: 'dingtalk',
  kind: 'channel',
  label: '钉钉',
  description: '在钉钉私聊中向投手提问。',
  capabilities: ['messaging']
}

const statusByState: Record<DingTalkConnectionState, ConnectionStatus> = {
  idle: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'degraded',
  error: 'failed'
}

type Transport = Pick<DingTalkStream, 'connect' | 'close' | 'reply'>
type StreamFactory = (configuration: DingTalkConfiguration, callbacks: {
  onMessage: (message: DingTalkIncomingMessage) => void
  onDisconnect: () => void
}) => Transport

interface Dependencies {
  storage?: Pick<DingTalkCredentialStore, 'load' | 'save' | 'clear'>
  createStream?: StreamFactory
  chat?: Pick<DingTalkChat, 'turn' | 'reset'>
}

function connectionError(error: unknown): DingTalkConnectionError {
  if (error instanceof DingTalkStreamError) {
    if (error.code === 'credentials') return 'invalid-credentials'
    if (error.code === 'protocol') return 'configuration'
    if (error.code === 'network') return 'network'
  }
  return 'connection-failed'
}

function splitReply(text: string): string[] {
  const parts: string[] = []
  let part = ''
  let size = 0
  for (const char of text) {
    const length = Buffer.byteLength(char)
    if (size + length > 4_000) {
      parts.push(part)
      part = ''
      size = 0
    }
    part += char
    size += length
  }
  if (part) parts.push(part)
  return parts
}

export class DingTalkConnectionManager {
  private readonly storage: NonNullable<Dependencies['storage']>
  private readonly createStream: StreamFactory
  private readonly chat: NonNullable<Dependencies['chat']>
  private configuration: DingTalkConfiguration | null = null
  private state: DingTalkConnectionState = 'idle'
  private configured = false
  private pairingCode?: string
  private lastError?: DingTalkConnectionError
  private lastConnectedAt?: number
  private lastMessageAt?: number
  private listener?: (snapshot: DingTalkConnectionSnapshot) => void
  private stream?: Transport
  private candidate?: Transport
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryCount = 0
  private epoch = 0
  private pending = Promise.resolve()
  private stopped = false
  private initialized = false
  private chatLifetime = new AbortController()
  private runningTurn?: symbol
  private readonly seen = new Map<string, number>()

  constructor(dependencies: Dependencies = {}) {
    this.storage = dependencies.storage ?? new DingTalkCredentialStore()
    this.createStream = dependencies.createStream ?? ((configuration, callbacks) => new DingTalkStream(configuration, callbacks))
    this.chat = dependencies.chat ?? new DingTalkChat()
  }

  getSnapshot(): DingTalkConnectionSnapshot {
    const clientId = this.configuration?.clientId
    const paired = Boolean(this.configuration?.owner)
    return {
      definition,
      state: this.state,
      status: this.state === 'connected' && !paired ? 'waiting_for_user' : statusByState[this.state],
      configured: this.configured,
      paired,
      pairingCode: this.state === 'connected' ? this.pairingCode : undefined,
      clientIdMasked: clientId ? `••••${clientId.length > 8 ? clientId.slice(-4) : ''}` : undefined,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError
    }
  }

  setStatusListener(listener: (snapshot: DingTalkConnectionSnapshot) => void): void {
    this.listener = listener
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initialized = true
    return this.serialize(async epoch => {
      if (await this.loadConfiguration(epoch) && this.configuration && this.current(epoch)) {
        await this.start(this.configuration, epoch)
      }
    })
  }

  connect(raw: unknown): Promise<DingTalkConnectionResult> {
    const credentials = parseDingTalkCredentials(raw)
    if (!credentials) return Promise.resolve(this.result('invalid-credentials'))
    const retryEpoch = secureStorageCoordinator.blockedEpoch()
    return this.serialize(async epoch => {
      // If a saved credential could not be read, a manual retry may unlock it.
      // Keep its verified pairing if the application ID matches.
      if (!this.configuration && this.configured) {
        if (!await this.loadConfiguration(epoch, retryEpoch)) return this.result('storage-unavailable')
      }
      if (!this.current(epoch)) return this.result('connection-failed')
      const current = this.configuration
      if (this.stream && current?.clientId === credentials.clientId && current.clientSecret === credentials.clientSecret) {
        return this.recoverStorage(epoch, retryEpoch)
      }
      const owner = current?.clientId === credentials.clientId ? current.owner : undefined
      return this.start({ ...credentials, ...(owner ? { owner } : {}) }, epoch, { retryEpoch })
    })
  }

  reconnect(): Promise<DingTalkConnectionResult> {
    const retryEpoch = secureStorageCoordinator.blockedEpoch()
    return this.serialize(async epoch => {
      if (!this.configuration && !await this.loadConfiguration(epoch, retryEpoch)) return this.result('storage-unavailable')
      if (!this.current(epoch)) return this.result('connection-failed')
      if (this.stream) return this.recoverStorage(epoch, retryEpoch)
      if (!this.configuration) return this.result('invalid-credentials')
      return this.start(this.configuration, epoch)
    })
  }

  disconnect(): Promise<DingTalkConnectionResult> {
    this.stopActivity()
    this.configuration = null
    this.lastConnectedAt = undefined
    this.lastMessageAt = undefined
    this.setState('idle')
    return this.serialize(async epoch => {
      try {
        await this.storage.clear()
        if (this.current(epoch)) {
          this.configured = false
          this.setState('idle')
        }
        return this.result()
      } catch {
        if (this.current(epoch)) this.setState('error', 'storage-unavailable')
        return this.result('storage-unavailable')
      }
    })
  }

  shutdown(): void {
    this.stopped = true
    this.stopActivity()
  }

  private serialize<T>(action: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = this.epoch
    const run = this.pending.then(() => action(epoch))
    this.pending = run.then(() => undefined, () => undefined)
    return run
  }

  private current(epoch: number): boolean { return epoch === this.epoch && !this.stopped }

  private async recoverStorage(epoch: number, retryEpoch: number | null): Promise<DingTalkConnectionResult> {
    if (this.lastError !== 'storage-unavailable') return this.result()
    try {
      const saved = await this.storage.load({ retry: true, retryEpoch })
      if (!this.current(epoch)) return this.result('connection-failed')
      if (saved && saved.clientId === this.configuration?.clientId && saved.clientSecret === this.configuration.clientSecret) {
        this.setState(this.stream ? 'connected' : 'reconnecting')
        return this.result()
      }
    } catch { /* Keep the current connection and report the next local action. */ }
    return this.result('storage-unavailable')
  }

  private async loadConfiguration(epoch: number, retryEpoch?: number | null): Promise<boolean> {
    if (!this.current(epoch)) return false
    try {
      const configuration = await this.storage.load(retryEpoch === undefined ? undefined : { retry: true, retryEpoch })
      if (!this.current(epoch)) return false
      this.configuration = configuration
      this.configured = configuration !== null
      return true
    } catch {
      if (this.current(epoch)) {
        this.configured = true
        this.setState('error', 'storage-unavailable')
      }
      return false
    }
  }

  private async start(
    configuration: DingTalkConfiguration,
    epoch: number,
    save?: { retryEpoch: number | null }
  ): Promise<DingTalkConnectionResult> {
    this.clearRetry()
    if (!this.stream) this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting')
    let dropped = false
    const candidate = this.createStream(configuration, {
      onMessage: message => this.receive(candidate, message),
      onDisconnect: () => {
        dropped = true
        if (this.stream === candidate) {
          this.stream = undefined
          this.setState('reconnecting', 'network')
          this.scheduleRetry()
        }
      }
    })
    this.candidate = candidate
    let failure: DingTalkConnectionError | undefined
    try {
      await candidate.connect()
      if (!this.current(epoch)) return this.result('connection-failed')
      if (dropped) return this.startFailed('network')
      if (save) {
        try {
          const committed = await this.storage.save(
            configuration,
            { retry: true, retryEpoch: save.retryEpoch },
            () => this.current(epoch) && !dropped
          )
          if (!committed && this.current(epoch)) failure = 'network'
        } catch {
          failure = 'storage-unavailable'
        }
        if (!this.current(epoch)) return this.result('connection-failed')
        if (failure) return this.startFailed(failure)
      }
      if (this.configuration?.clientId !== configuration.clientId) {
        this.resetChat()
        this.pairingCode = undefined
        this.lastMessageAt = undefined
      }
      this.configured = true
      this.configuration = configuration
      const previous = this.stream
      this.stream = dropped ? undefined : candidate
      previous?.close()
      if (dropped) return this.startFailed('network')
      if (!configuration.owner) this.pairingCode ??= randomBytes(6).toString('hex')
      this.clearRetry()
      this.retryCount = 0
      this.lastConnectedAt = Date.now()
      this.setState('connected')
      return this.result()
    } catch (error) {
      return this.current(epoch) ? this.startFailed(connectionError(error)) : this.result('connection-failed')
    } finally {
      this.candidate = undefined
      if (this.stream !== candidate) candidate.close()
    }
  }

  private startFailed(error: DingTalkConnectionError): DingTalkConnectionResult {
    if (this.stream) return this.result(error)
    const retryable = error === 'network' || error === 'connection-failed'
    const retry = retryable && this.configuration !== null
    this.setState(retry ? 'reconnecting' : 'error', error)
    if (retry) this.scheduleRetry()
    return this.result(error)
  }

  private scheduleRetry(): void {
    if (!this.configuration || this.stopped || this.retryTimer) return
    const delay = Math.min(60_000, 2_000 * 2 ** this.retryCount++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.serialize(async epoch => {
        if (this.current(epoch) && this.configuration && !this.stream) await this.start(this.configuration, epoch)
      })
    }, delay)
    this.retryTimer.unref()
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private stopActivity(): void {
    this.epoch++
    this.clearRetry()
    this.retryCount = 0
    const active = this.stream
    this.stream = undefined
    active?.close()
    this.candidate?.close()
    this.pairingCode = undefined
    this.resetChat()
  }

  private resetChat(): void {
    this.chatLifetime.abort()
    this.chatLifetime = new AbortController()
    this.runningTurn = undefined
    this.chat.reset()
    this.seen.clear()
  }

  private receive(stream: Transport, message: DingTalkIncomingMessage): void {
    if (this.stream !== stream || message.conversationType !== 'direct' || !this.configuration) return
    const owner = this.configuration.owner
    if (!owner) {
      const code = this.pairingCode
      if (!code || message.text.trim() !== `/pair ${code}`) return
      void this.serialize(async epoch => {
        if (!this.current(epoch) || this.stream !== stream || this.pairingCode !== code || !this.configuration || this.configuration.owner) return
        const bound = { ...this.configuration, owner: { senderId: message.senderId, conversationId: message.conversationId } }
        const signal = this.chatLifetime.signal
        try {
          if (!await this.storage.save(bound, undefined, () => this.current(epoch))) return
        } catch {
          if (this.current(epoch)) this.setState(this.state, 'storage-unavailable')
          await this.reply(stream, message, '投手无法存储绑定。请在桌面端重试连接。', signal)
          return
        }
        if (!this.current(epoch)) return
        this.configuration = bound
        this.pairingCode = undefined
        this.lastMessageAt = Date.now()
        this.setState(this.state, this.state === 'connected' ? undefined : this.lastError)
        await this.reply(stream, message, '钉钉已绑定投手。现在可以发文字提问，也可以发 /ping 检查连接。', signal)
      })
      return
    }
    if (owner.senderId !== message.senderId || owner.conversationId !== message.conversationId) return
    const now = Date.now()
    for (const [id, receivedAt] of this.seen) {
      if (now - receivedAt <= 10 * 60_000) break
      this.seen.delete(id)
    }
    if (this.seen.has(message.id)) return
    this.seen.set(message.id, now)
    const oldest = this.seen.keys().next().value
    if (this.seen.size > 512 && oldest !== undefined) this.seen.delete(oldest)
    this.lastMessageAt = now
    this.emit()
    void this.answer(stream, message)
  }

  private async answer(stream: Transport, message: DingTalkIncomingMessage): Promise<void> {
    const signal = this.chatLifetime.signal
    const text = message.text.trim()
    if (text === '/ping') return this.reply(stream, message, '投手连接正常。', signal)
    if (text.startsWith('/pair ')) return
    if (this.runningTurn) return this.reply(stream, message, '上一条消息仍在处理，请稍后重试。', signal)
    if (text === '/new') {
      this.chat.reset()
      return this.reply(stream, message, '已开始新的对话。', signal)
    }
    if (!text) return this.reply(stream, message, '请发送文字消息。', signal)
    const turn = Symbol()
    this.runningTurn = turn
    try {
      const answer = await this.chat.turn(text, signal)
      await this.reply(stream, message, answer, signal)
    } catch {
      await this.reply(stream, message, '这次没有生成回复。请检查投手桌面端的模型设置，稍后重试。', signal)
    } finally {
      if (this.runningTurn === turn) this.runningTurn = undefined
    }
  }

  private async reply(stream: Transport, message: DingTalkIncomingMessage, text: string, signal: AbortSignal): Promise<void> {
    try {
      for (const part of splitReply(text)) {
        if (signal.aborted) return
        await stream.reply(message, part, signal)
      }
    } catch {
      // Session webhooks expire. Retrying a reply without a delivery receipt
      // could duplicate it or deliver it to a different conversation.
    }
  }

  private result(error?: DingTalkConnectionError): DingTalkConnectionResult {
    return { ok: !error, snapshot: this.getSnapshot(), ...(error ? { error } : {}) }
  }

  private setState(state: DingTalkConnectionState, error?: DingTalkConnectionError): void {
    this.state = state
    this.lastError = error
    this.emit()
  }

  private emit(): void { this.listener?.(this.getSnapshot()) }
}

export const dingTalkConnectionManager = new DingTalkConnectionManager()
