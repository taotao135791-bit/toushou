import { readFile, writeFile } from 'node:fs/promises'
import { ChatMessage, Session, SessionEvent, SessionState } from '../../../shared/types'
import { FeishuCapability } from '../../../shared/connections'
import { NormalizedFeishuMessage } from './FeishuChannel'

export interface FeishuSessionRoute {
  key: string
  chatId: string
  chatType: 'p2p' | 'group'
  rootId?: string
  threadId?: string
  sessionId?: string
  sessionFile?: string
  lastMessageId?: string
  lastSenderId?: string
  updatedAt: number
}

export interface FeishuSessionRouterOptions {
  workspacePath: string
  routesFile: string
  createSession: (
    cwd: string,
    onEvent: (event: SessionEvent) => void,
    opts?: { permissionMode?: 'readonly' }
  ) => Session
  sendMessage: (sessionId: string, text: string) => boolean
  getSession: (sessionId: string) => Session | undefined
  getSessionState: (sessionId: string) => Promise<SessionState | null>
  resumeSession: (
    cwd: string,
    onEvent: (event: SessionEvent) => void,
    filePath: string
  ) => Promise<{ session: Session; messages: ChatMessage[] } | null>
  killSession: (sessionId: string) => boolean
  onReply: (route: FeishuSessionRoute, content: string, sourceMessageId: string) => Promise<void>
  onProgress?: (route: FeishuSessionRoute) => Promise<void>
  ownerOpenId?: string
}

interface StoredRoute {
  key: string
  chatId: string
  chatType: 'p2p' | 'group'
  rootId?: string
  threadId?: string
  sessionFile?: string
  updatedAt: number
}

/** Stable Feishu chat/thread → one existing Toushou OMP session. */
export class FeishuSessionRouter {
  private readonly routes = new Map<string, FeishuSessionRoute>()
  private readonly drafts = new Map<string, string>()
  private readonly seenMessageIds = new Map<string, number>()
  private readonly opts: FeishuSessionRouterOptions
  private ownerOpenId: string | undefined
  private loaded = false

  constructor(options: FeishuSessionRouterOptions) {
    this.opts = options
    this.ownerOpenId = options.ownerOpenId
  }

  setOwnerOpenId(ownerOpenId?: string): void {
    this.ownerOpenId = ownerOpenId
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.opts.routesFile, 'utf8')) as unknown
      if (!Array.isArray(raw)) return
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const value = item as Record<string, unknown>
        if (
          typeof value.key !== 'string' ||
          typeof value.chatId !== 'string' ||
          (value.chatType !== 'p2p' && value.chatType !== 'group')
        ) continue
        this.routes.set(value.key, {
          key: value.key,
          chatId: value.chatId,
          chatType: value.chatType,
          rootId: typeof value.rootId === 'string' ? value.rootId : undefined,
          threadId: typeof value.threadId === 'string' ? value.threadId : undefined,
          sessionFile: typeof value.sessionFile === 'string' ? value.sessionFile : undefined,
          updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
        })
      }
    } catch {
      // First launch or a corrupt optional route index: start cleanly.
    }
  }

  async handleInbound(message: NormalizedFeishuMessage): Promise<void> {
    await this.load()
    this.sweepSeen()
    if (this.seenMessageIds.has(message.messageId)) return
    this.seenMessageIds.set(message.messageId, Date.now())

    // Prompt-injection defence: only the owner may use a PersonalAgent in a
    // private chat. In groups the SDK and this second check require an @mention.
    if (message.chatType === 'p2p' && (!this.ownerOpenId || message.senderId !== this.ownerOpenId)) return
    if (message.chatType === 'group' && !message.mentionedBot) return

    const key = routeKey(message.chatId, message.rootId ?? message.threadId)
    let route = this.routes.get(key)
    if (!route) {
      route = {
        key,
        chatId: message.chatId,
        chatType: message.chatType,
        rootId: message.rootId,
        threadId: message.threadId,
        updatedAt: Date.now()
      }
      this.routes.set(key, route)
      await this.persist()
    }
    route.lastMessageId = message.messageId
    route.lastSenderId = message.senderId
    route.updatedAt = Date.now()

    const session = await this.ensureSession(route)
    if (!session) {
      await this.opts.onReply(route, '投手暂时无法启动分析，请稍后重试。', message.messageId)
      return
    }

    await this.opts.onProgress?.(route)
    const media = message.resources.map((resource) =>
      resource.type === 'image'
        ? `\n[已收到一张图片，资源标识为 ${resource.fileKey}]`
        : `\n[已收到一个文件${resource.fileName ? `：${resource.fileName}` : ''}，资源标识为 ${resource.fileKey}]`
    ).join('')
    const prompt = `${message.content.trim()}${media}`.trim()
    if (!prompt) return
    if (!this.opts.sendMessage(session.id, prompt)) {
      await this.opts.onReply(route, '这条消息没有送达投手，请稍后重试。', message.messageId)
    }
  }

  onSessionEvent(event: SessionEvent): void {
    const route = Array.from(this.routes.values()).find((item) => item.sessionId === event.sessionId)
    if (!route) return
    if (event.type === 'message' && event.role === 'assistant') {
      this.drafts.set(route.key, `${this.drafts.get(route.key) ?? ''}${event.content}`)
      return
    }
    if (event.type === 'status' && event.status === 'idle' && event.isTerminal !== false) {
      const draft = (this.drafts.get(route.key) ?? '').trim()
      this.drafts.delete(route.key)
      if (draft) void this.opts.onReply(route, draft, route.lastMessageId ?? '')
      return
    }
    if (event.type === 'error' && event.recoverable !== true) {
      this.drafts.delete(route.key)
      void this.opts.onReply(route, '投手这次处理没有完成，请稍后重试。', route.lastMessageId ?? '')
    }
    if (event.type === 'closed') {
      route.sessionId = undefined
      void this.persist()
    }
  }

  async shutdown(): Promise<void> {
    for (const route of this.routes.values()) {
      if (route.sessionId) this.opts.killSession(route.sessionId)
    }
  }

  listRoutes(): FeishuSessionRoute[] {
    return [...this.routes.values()].map((route) => ({ ...route }))
  }

  private async ensureSession(route: FeishuSessionRoute): Promise<Session | null> {
    if (route.sessionId) {
      const live = this.opts.getSession(route.sessionId)
      if (live) return live
      route.sessionId = undefined
    }

    if (route.sessionFile) {
      const resumed = await this.opts.resumeSession(this.opts.workspacePath, (event) => this.onSessionEvent(event), route.sessionFile)
      if (resumed) {
        route.sessionId = resumed.session.id
        await this.persist()
        return resumed.session
      }
    }

    const session = this.opts.createSession(this.opts.workspacePath, (event) => this.onSessionEvent(event), {
      // Remote messages must not silently gain local write/exec access.
      permissionMode: 'readonly'
    })
    if (session.status === 'error') return null
    route.sessionId = session.id
    await this.persist()
    // The session file is available after the OMP handshake. Keep the route
    // index path-only and Main-owned; it is never shown to the renderer.
    void this.opts.getSessionState(session.id).then(async (state) => {
      if (!state?.sessionFile || route.sessionId !== session.id) return
      route.sessionFile = state.sessionFile
      await this.persist()
    })
    return session
  }

  private async persist(): Promise<void> {
    const serializable: StoredRoute[] = this.listRoutes().map(({ sessionId: _sessionId, lastMessageId: _lastMessageId, lastSenderId: _lastSenderId, ...route }) => route)
    try {
      await writeFile(this.opts.routesFile, JSON.stringify(serializable), { mode: 0o600 })
    } catch {
      // Routing remains live if the optional index cannot be written.
    }
  }

  private sweepSeen(): void {
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [id, timestamp] of this.seenMessageIds) if (timestamp < cutoff) this.seenMessageIds.delete(id)
  }
}

export function routeKey(chatId: string, threadOrRootId?: string): string {
  return `${chatId}:${threadOrRootId || 'conversation'}`
}

export const FEISHU_READONLY_CAPABILITIES: FeishuCapability[] = ['messaging', 'docs.read', 'sheets.read', 'bitable.read']
