import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type SendResult
} from '@larksuiteoapi/node-sdk'
import { FeishuStoredCredentials } from './FeishuCredentialStore'

export interface FeishuMediaResource {
  type: 'image' | 'file'
  fileKey: string
  fileName?: string
}

export interface NormalizedFeishuMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderId: string
  content: string
  mentionedBot: boolean
  rootId?: string
  threadId?: string
  replyToMessageId?: string
  resources: FeishuMediaResource[]
  createTime: number
  raw?: unknown
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseMessageContent(value: string): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'string') return parsed
    if (!parsed || typeof parsed !== 'object') return value
    const texts: string[] = []
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      const record = node as Record<string, unknown>
      if (typeof record.text === 'string') texts.push(record.text)
      if (record.content) visit(record.content)
      if (record.elements) visit(record.elements)
    }
    visit(parsed)
    return texts.join('').trim() || value
  } catch {
    return value
  }
}

/**
 * Normalize both SDK messages and mocked raw receive_v1 events. Keeping this
 * pure makes message parsing and prompt-injection policy straightforward to
 * test without a live Feishu account.
 */
export function parseFeishuMessage(raw: unknown): NormalizedFeishuMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  if (typeof root.messageId === 'string' && typeof root.chatId === 'string') {
    const normalized = root as Record<string, unknown>
    return {
      messageId: stringValue(normalized.messageId),
      chatId: stringValue(normalized.chatId),
      chatType: normalized.chatType === 'p2p' ? 'p2p' : 'group',
      senderId: stringValue(normalized.senderId),
      content: stringValue(normalized.content),
      mentionedBot: normalized.mentionedBot === true,
      rootId: stringValue(normalized.rootId) || undefined,
      threadId: stringValue(normalized.threadId) || undefined,
      replyToMessageId: stringValue(normalized.replyToMessageId) || undefined,
      resources: Array.isArray(normalized.resources)
        ? normalized.resources.filter((item): item is FeishuMediaResource => {
            if (!item || typeof item !== 'object') return false
            const value = item as Record<string, unknown>
            return (value.type === 'image' || value.type === 'file') && typeof value.fileKey === 'string'
          })
        : [],
      createTime: typeof normalized.createTime === 'number' ? normalized.createTime : Date.now(),
      raw: normalized.raw
    }
  }
  const event = (root.event && typeof root.event === 'object' ? root.event : root) as Record<string, unknown>
  const message = (event.message && typeof event.message === 'object' ? event.message : event) as Record<string, unknown>
  const sender = (event.sender && typeof event.sender === 'object' ? event.sender : {}) as Record<string, unknown>
  const senderIdObject = (sender.sender_id && typeof sender.sender_id === 'object' ? sender.sender_id : {}) as Record<string, unknown>
  const messageId = stringValue(message.message_id) || stringValue(event.open_message_id)
  const chatId = stringValue(message.chat_id) || stringValue(event.open_chat_id)
  const rawChatType = stringValue(message.chat_type) || stringValue(event.chat_type)
  const chatType: 'p2p' | 'group' = rawChatType === 'p2p' ? 'p2p' : 'group'
  const senderId = stringValue(senderIdObject.open_id) || stringValue(event.open_id)
  if (!messageId || !chatId || !senderId) return null

  const content = parseMessageContent(
    stringValue(message.content) || stringValue(event.text_without_at_bot) || stringValue(event.text)
  )
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const mentionedBot =
    message.is_mention === true ||
    event.is_mention === true ||
    mentions.some((item) => {
      if (!item || typeof item !== 'object') return false
      const mention = item as Record<string, unknown>
      return mention.is_bot === true || mention.name === '投手'
    })
  const resources: FeishuMediaResource[] = []
  const resourceType = stringValue(message.message_type) || stringValue(event.msg_type)
  // Resource keys are intentionally only passed to the OMP prompt as a short
  // hint; actual downloads remain Main-only and can be added to the tool layer.
  if (resourceType === 'image' || resourceType === 'file') {
    try {
      const parsed = JSON.parse(stringValue(message.content) || '{}') as Record<string, unknown>
      const key = stringValue(parsed.image_key) || stringValue(parsed.file_key)
      if (key) resources.push({ type: resourceType, fileKey: key, fileName: stringValue(parsed.file_name) || undefined })
    } catch {
      // malformed media content is still a valid inbound event
    }
  }
  const timestamp = Number(message.create_time ?? event.create_time ?? Date.now())
  return {
    messageId,
    chatId,
    chatType,
    senderId,
    content,
    mentionedBot,
    rootId: stringValue(message.root_id) || undefined,
    threadId: stringValue(message.thread_id) || undefined,
    replyToMessageId: stringValue(message.parent_id) || undefined,
    resources,
    createTime: Number.isFinite(timestamp) ? timestamp > 1e12 ? timestamp : timestamp * 1000 : Date.now(),
    raw
  }
}

export interface FeishuChannelHandlers {
  onMessage: (message: NormalizedFeishuMessage) => void | Promise<void>
  onReconnecting?: () => void
  onReconnected?: () => void
  onError?: (error: Error) => void
}

export class FeishuChannel {
  private readonly channel: LarkChannel

  constructor(credentials: FeishuStoredCredentials, handlers: FeishuChannelHandlers) {
    const sdkDomain = credentials.brand === 'lark' ? Domain.Lark : Domain.Feishu
    this.channel = createLarkChannel({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: sdkDomain,
      transport: 'websocket',
      source: 'toushou',
      loggerLevel: LoggerLevel.warn,
      policy: {
        dmMode: 'open',
        requireMention: true,
        respondToMentionAll: false
      },
      safety: {
        dedup: { ttl: 10 * 60 * 1000, maxEntries: 2_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 10 * 60 * 1000
      },
      outbound: { textChunkLimit: 8_000, streamThrottleMs: 700 },
      includeRawEvent: true
    })
    this.channel.on({
      message: (message: NormalizedMessage) => {
        const parsed = parseFeishuMessage(message)
        if (parsed) return handlers.onMessage(parsed)
      },
      reconnecting: () => handlers.onReconnecting?.(),
      reconnected: () => handlers.onReconnected?.(),
      error: (error: Error) => handlers.onError?.(error)
    })
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.channel.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('飞书 WebSocket 连接超时')), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async disconnect(): Promise<void> {
    await this.channel.disconnect()
  }

  async sendMarkdown(
    chatId: string,
    content: string,
    options: { replyTo?: string; replyInThread?: boolean } = {}
  ): Promise<SendResult> {
    return this.channel.send(
      chatId,
      { markdown: content.slice(0, 30_000) },
      { replyTo: options.replyTo, replyInThread: options.replyInThread }
    )
  }

  async sendCard(chatId: string, card: object, options: { replyTo?: string; replyInThread?: boolean } = {}): Promise<SendResult> {
    return this.channel.send(chatId, { card }, options)
  }

  async updateMessage(messageId: string, content: string): Promise<void> {
    await this.channel.editMessage(messageId, content.slice(0, 30_000))
  }

  get botName(): string | undefined {
    return this.channel.botIdentity?.name
  }

  get botOpenId(): string | undefined {
    return this.channel.botIdentity?.openId
  }

  get websocketState(): 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | undefined {
    return this.channel.getConnectionStatus()?.state
  }

  get rawClient() {
    return this.channel.rawClient
  }
}
