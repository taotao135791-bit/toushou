import WebSocket from 'ws'
import type { DingTalkCredentials } from '../../../shared/connections'

const OPEN_CONNECTION_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
const STREAM_HOSTS = new Set(['wss-open-connection.dingtalk.com', 'wss-open-connection-union.dingtalk.com'])
const REPLY_HOSTS = new Set(['oapi.dingtalk.com', 'api.dingtalk.com'])
const HTTP_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 12_000
const KEEPALIVE_INTERVAL_MS = 30_000
const SERVER_DISCONNECT_GRACE_MS = 12_000
const MAX_HTTP_BYTES = 64 * 1024
const MAX_FRAME_BYTES = 256 * 1024
const MAX_SEEN_MESSAGES = 1_000

/** Main-only. The reply URL contains a temporary bearer credential. */
export interface DingTalkIncomingMessage {
  id: string
  conversationId: string
  conversationType: 'direct' | 'group'
  conversationName?: string
  senderId: string
  senderName?: string
  senderIsAdmin?: boolean
  text: string
  replyUrl: string
  replyExpiresAt: number
}

interface DingTalkStreamCallbacks {
  onMessage(message: DingTalkIncomingMessage): void
  onDisconnect(): void
}

type StreamErrorCode = 'credentials' | 'network' | 'protocol' | 'cancelled' | 'reply-expired' | 'reply-failed'

const STREAM_ERROR_MESSAGES: Record<StreamErrorCode, string> = {
  credentials: '钉钉拒绝连接。请检查应用凭证、机器人发布状态和 Stream 接收模式。',
  network: '无法建立或保持钉钉连接，请检查网络后重试。',
  protocol: '钉钉长连接返回了无法识别的响应。',
  cancelled: '钉钉操作已取消。',
  'reply-expired': '钉钉消息的回复链接已过期，请重新发送消息。',
  'reply-failed': '钉钉未能发送机器人回复。'
}

export class DingTalkStreamError extends Error {
  constructor(readonly code: StreamErrorCode) {
    super(STREAM_ERROR_MESSAGES[code])
    this.name = 'DingTalkStreamError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function checkedUrl(value: unknown, protocol: 'wss:' | 'https:', hosts: Set<string>): URL | undefined {
  const input = stringField(value, 4096)
  if (!input || !URL.canParse(input)) return
  const url = new URL(input)
  if (url.protocol !== protocol || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash) return
  return url
}

function replyEndpoint(value: unknown): URL | undefined {
  const url = checkedUrl(value, 'https:', REPLY_HOSTS)
  if (url?.pathname !== '/robot/sendBySession' || !url.searchParams.get('session')) return
  return url
}

function parseBotMessage(data: string): DingTalkIncomingMessage | undefined {
  const event = jsonRecord(data)
  if (event?.msgtype !== 'text') return
  const conversationType = event.conversationType === '1' ? 'direct' : event.conversationType === '2' ? 'group' : undefined
  if (!conversationType || (conversationType === 'group' && event.isInAtList === false)) return
  const id = stringField(event.msgId, 256)
  const conversationId = stringField(event.conversationId, 256)
  const staffId = stringField(event.senderStaffId, 256)
  const corpId = stringField(event.senderCorpId, 256)
  const senderId = stringField(event.senderId, 256) ?? (corpId && staffId ? `${corpId}:${staffId}` : undefined)
  const text = stringField(record(event.text)?.content, 32_000)?.trim()
  const replyUrl = replyEndpoint(event.sessionWebhook)
  const expiresAt = event.sessionWebhookExpiredTime
  const replyExpiresAt = typeof expiresAt === 'number' || typeof expiresAt === 'string' ? Number(expiresAt) : NaN
  if (!id || !conversationId || !senderId || !text || !replyUrl || !Number.isSafeInteger(replyExpiresAt) || replyExpiresAt <= 0) return
  return {
    id,
    conversationId,
    conversationType,
    conversationName: stringField(event.conversationTitle, 256),
    senderId,
    senderName: stringField(event.senderNick, 128),
    senderIsAdmin: typeof event.isAdmin === 'boolean' ? event.isAdmin : undefined,
    text,
    replyUrl: replyUrl.href,
    replyExpiresAt
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_HTTP_BYTES) {
        await reader.cancel()
        return
      }
      chunks.push(value)
    }
    return jsonRecord(Buffer.concat(chunks, length).toString('utf8'))
  } finally {
    reader.releaseLock()
  }
}

/** One ticket and one socket. The connection manager creates a fresh stream on reconnect. */
export class DingTalkStream {
  private readonly stop = new AbortController()
  private readonly seenMessageIds = new Set<string>()
  private start: Promise<void> | undefined

  constructor(
    private readonly credentials: DingTalkCredentials,
    private readonly callbacks: DingTalkStreamCallbacks,
    private readonly fetchRequest: typeof fetch = fetch,
    private readonly createSocket: (url: URL, options: WebSocket.ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options)
  ) {}

  connect(): Promise<void> {
    return this.start ??= this.open()
  }

  close(): void {
    this.stop.abort()
  }

  async reply(message: DingTalkIncomingMessage, content: string, signal?: AbortSignal): Promise<void> {
    const url = replyEndpoint(message.replyUrl)
    if (!url) throw new DingTalkStreamError('reply-failed')
    if (message.replyExpiresAt <= Date.now()) throw new DingTalkStreamError('reply-expired')
    const signals = signal ? [this.stop.signal, signal] : [this.stop.signal]
    try {
      const result = await this.post(url, { msgtype: 'text', text: { content } }, signals)
      if (result.status >= 200 && result.status < 300 && (result.body?.errcode === 0 || result.body?.errcode === '0')) return
    } catch {
      if (signals.some((value) => value.aborted)) throw new DingTalkStreamError('cancelled')
    }
    throw new DingTalkStreamError('reply-failed')
  }

  private async post(url: string | URL, payload: unknown, signals: AbortSignal[]) {
    const signal = AbortSignal.any([...signals, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
    signal.throwIfAborted()
    const response = await this.fetchRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error'
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { status: response.status, body: undefined }
    }
    return { status: response.status, body: await readJson(response) }
  }

  private async open(): Promise<void> {
    const result = await this.post(OPEN_CONNECTION_URL, {
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
      subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }]
    }, [this.stop.signal]).catch(() => {
      throw new DingTalkStreamError(this.stop.signal.aborted ? 'cancelled' : 'network')
    })
    if (this.stop.signal.aborted) throw new DingTalkStreamError('cancelled')
    if ([400, 401, 403].includes(result.status)) throw new DingTalkStreamError('credentials')
    if (result.status < 200 || result.status >= 300) throw new DingTalkStreamError('network')
    const url = checkedUrl(result.body?.endpoint, 'wss:', STREAM_HOSTS)
    const ticket = stringField(result.body?.ticket, 1024)
    if (!url || !ticket) throw new DingTalkStreamError('protocol')
    url.searchParams.set('ticket', ticket)
    await this.openSocket(url)
  }

  private openSocket(url: URL): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = this.createSocket(url, {
          followRedirects: false,
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false
        })
      } catch {
        reject(new DingTalkStreamError('network'))
        return
      }

      let opened = false
      let finished = false
      let pongReceived = true
      let keepalive: ReturnType<typeof setInterval> | undefined
      let disconnectGrace: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (finished) return
        finished = true
        clearInterval(keepalive)
        clearTimeout(disconnectGrace)
        this.stop.signal.removeEventListener('abort', finish)
        socket.terminate()
        if (!opened) reject(new DingTalkStreamError(this.stop.signal.aborted ? 'cancelled' : 'network'))
        else if (!this.stop.signal.aborted) this.callbacks.onDisconnect()
      }

      socket.on('close', finish)
      socket.on('error', finish)
      this.stop.signal.addEventListener('abort', finish, { once: true })
      socket.on('pong', () => { pongReceived = true })
      socket.once('open', () => {
        if (finished) return
        opened = true
        keepalive = setInterval(() => {
          if (!pongReceived || socket.readyState !== WebSocket.OPEN) {
            finish()
            return
          }
          pongReceived = false
          socket.ping(undefined, undefined, (error) => { if (error) finish() })
        }, KEEPALIVE_INTERVAL_MS).unref()
        resolve()
      })
      socket.on('message', (raw, binary) => {
        if (!opened || finished || binary || !Buffer.isBuffer(raw)) return
        const frame = jsonRecord(raw.toString('utf8'))
        const headers = record(frame?.headers)
        const topic = headers?.topic
        if (frame?.type === 'SYSTEM' && topic === 'disconnect') {
          // The server closes the socket after its ten-second drain period.
          disconnectGrace ??= setTimeout(finish, SERVER_DISCONNECT_GRACE_MS).unref()
          return
        }
        const messageId = stringField(headers?.messageId, 256)
        if (!messageId || typeof frame?.data !== 'string') return
        if (frame.type === 'SYSTEM' && topic === 'ping') this.acknowledge(socket, messageId, frame.data, finish)
        if (frame.type === 'CALLBACK' && topic === BOT_TOPIC) {
          this.acknowledge(socket, messageId, '{"response":null}', finish)
          const message = parseBotMessage(frame.data)
          if (message && !this.seenMessageIds.has(message.id)) this.deliver(message)
        }
      })
      if (this.stop.signal.aborted) finish()
    })
  }

  private acknowledge(socket: WebSocket, messageId: string, data: string, onFailure: () => void): void {
    socket.send(JSON.stringify({
      code: 200,
      headers: { messageId, contentType: 'application/json' },
      message: 'OK',
      data
    }), (error) => { if (error) onFailure() })
  }

  private deliver(message: DingTalkIncomingMessage): void {
    this.seenMessageIds.add(message.id)
    if (this.seenMessageIds.size > MAX_SEEN_MESSAGES) {
      const firstId = this.seenMessageIds.values().next().value
      if (firstId) this.seenMessageIds.delete(firstId)
    }
    // Contain local observer failures without logging an untrusted callback or URL.
    try {
      this.callbacks.onMessage(message)
    } catch {
      this.seenMessageIds.delete(message.id)
    }
  }
}
