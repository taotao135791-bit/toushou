import { FeishuCapability, FeishuToolRequest, FeishuToolResult } from '../../../shared/connections'
import { withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { FeishuChannel } from './FeishuChannel'

type RawClient = FeishuChannel['rawClient']

/**
 * Appended to authorization-class tool errors. The plain-language line tells
 * the agent to stop retrying (an opaque 400 used to send it into a minutes-
 * long flail), and the [[connect:feishu]] marker — when relayed into the
 * assistant reply on its own line — renders the permission-gap guide card
 * (see renderer/lib/connectionMarkers.ts).
 */
const AUTH_GUIDE = '\n请停止重试本操作，并告知用户到「连接」页补齐飞书授权。\n[[connect:feishu]]'

/** Feishu API error codes that mean "wrong/missing token or scope". */
const PERMISSION_ERROR_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991679, 230002])

/**
 * Small, agent-oriented Feishu tool surface. It deliberately exposes high
 * level operations instead of forwarding arbitrary Open API URLs.
 */
export class FeishuToolRegistry {
  private readonly breaker = new SessionToolBreaker()

  constructor(
    private readonly getChannel: () => FeishuChannel | null,
    private readonly isCapabilityAuthorized: (capability: FeishuCapability) => boolean,
    private readonly getUserAccessToken?: (capability: FeishuCapability) => Promise<string | null>
  ) {}

  /**
   * Session-scoped entry point used by the bridge. Wraps execute() with a
   * per-session circuit breaker so a model that ignores error text cannot
   * keep hammering a failing integration forever.
   */
  async executeForSession(sessionId: string, request: FeishuToolRequest): Promise<FeishuToolResult> {
    const blocked = this.breaker.check(sessionId)
    if (blocked) return blocked
    const result = await this.execute(request)
    this.breaker.note(sessionId, result)
    return result
  }

/** True while the session's feishu calls are paused by the breaker. */
  isPaused(sessionId: string): boolean {
    const until = this.breaker.pausedUntil.get(sessionId)
    return !!until && this.breaker.now() < until
  }

  async execute(request: FeishuToolRequest): Promise<FeishuToolResult> {
    const capability = capabilityFor(request.action)
    if (!this.isCapabilityAuthorized(capability)) {
      return authorizationRefused(capability)
    }
    const channel = this.getChannel()
    if (!channel) return { ok: false, error: '飞书尚未连接。' + AUTH_GUIDE }
    try {
      const userAccessToken = capability === 'messaging' ? null : await this.getUserAccessToken?.(capability)
      if (capability !== 'messaging' && !userAccessToken) {
        return authorizationRefused(capability)
      }
      switch (request.action) {
        case 'message_send': {
          const chatId = string(request.chatId)
          const content = string(request.content)
          if (!chatId || !content) return invalid('chatId 和 content 不能为空')
          return { ok: true, data: await channel.sendMarkdown(chatId, content) }
        }
        case 'message_reply': {
          const chatId = string(request.chatId)
          const messageId = string(request.messageId)
          const content = string(request.content)
          if (!chatId || !messageId || !content) return invalid('chatId、messageId 和 content 不能为空')
          return { ok: true, data: await channel.sendMarkdown(chatId, content, { replyTo: messageId, replyInThread: request.replyInThread !== false }) }
        }
        case 'message_read': {
          const messageId = string(request.messageId)
          if (!messageId) return invalid('messageId 不能为空')
          return await this.request(channel.rawClient, 'GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {}, userAccessToken)
        }
        case 'message_search': {
          // /search/v2/message rejects tenant tokens with an opaque 400 —
          // capabilityFor routes this to 'search', which requires a user token.
          const query = string(request.query)
          if (!query) return invalid('query 不能为空')
          return await this.request(channel.rawClient, 'POST', '/open-apis/search/v2/message', { data: { query: query.slice(0, 200), page_size: 20 } }, userAccessToken)
        }
        case 'doc_list':
          // Root folder listing ordered by last edit — the closest thing to
          // "my recent documents" the drive API offers without a folder token.
          return await this.request(channel.rawClient, 'GET', '/open-apis/drive/v1/files', {
            params: { page_size: 50, order_by: 'EditedTime', direction: 'DESC' }
          }, userAccessToken)
        case 'doc_search': {
          const query = string(request.query)
          if (!query) return invalid('query 不能为空')
          return await this.request(channel.rawClient, 'POST', '/open-apis/suite/docs-api/search/object', {
            data: { search_key: query.slice(0, 100), count: 20, offset: 0 }
          }, userAccessToken)
        }
        case 'doc_read': {
          const documentId = string(request.documentId)
          if (!documentId) return invalid('documentId 不能为空')
          return await this.request(channel.rawClient, 'GET', `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {}, userAccessToken)
        }
        case 'doc_create':
          return await this.request(channel.rawClient, 'POST', '/open-apis/docx/v1/documents', { data: { title: string(request.title).slice(0, 100) } }, userAccessToken)
        case 'doc_append': {
          const documentId = string(request.documentId)
          if (!documentId) return invalid('documentId 不能为空')
          return await this.request(channel.rawClient, 'POST', `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, {
            data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: string(request.content).slice(0, 20_000) } }] } }] }
          }, userAccessToken)
        }
        case 'sheets_read': {
          const spreadsheetToken = string(request.spreadsheetToken)
          const range = string(request.range)
          if (!spreadsheetToken || !range) return invalid('spreadsheetToken 和 range 不能为空')
          return await this.request(channel.rawClient, 'GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, {}, userAccessToken)
        }
        case 'sheets_write': {
          const spreadsheetToken = string(request.spreadsheetToken)
          const range = string(request.range)
          if (!spreadsheetToken || !range) return invalid('spreadsheetToken 和 range 不能为空')
          return await this.request(channel.rawClient, 'PUT', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`, {
            data: { valueRange: { range, values: Array.isArray(request.values) ? request.values : [] } }
          }, userAccessToken)
        }
        case 'sheets_create':
          return await this.request(channel.rawClient, 'POST', '/open-apis/sheets/v3/spreadsheets', { data: { title: string(request.title).slice(0, 100) } }, userAccessToken)
        case 'bitable_read': {
          const guard = bitableParams(request)
          if (guard) return guard
          return await this.request(channel.rawClient, 'GET', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records`, { params: { page_size: 100 } }, userAccessToken)
        }
        case 'bitable_upsert': {
          const guard = bitableParams(request)
          if (guard) return guard
          return await this.request(channel.rawClient, 'POST', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records`, { data: { fields: request.fields ?? {} } }, userAccessToken)
        }
        case 'bitable_query': {
          const guard = bitableParams(request)
          if (guard) return guard
          return await this.request(channel.rawClient, 'POST', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records/search`, { data: { filter: request.filter, page_size: 100 } }, userAccessToken)
        }
      }
    } catch (error) {
      return { ok: false, error: safeError(error) }
    }
  }

  private async request(client: RawClient, method: string, url: string, extra: Record<string, unknown> = {}, userAccessToken: string | null = null): Promise<FeishuToolResult> {
    const config = { method, url, ...extra } as Parameters<RawClient['request']>[0]
    const response = await client.request(config, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
    const code = typeof response.code === 'number' ? response.code : 0
    if (code !== 0) return { ok: false, error: friendlyApiError(response) }
    return { ok: true, data: response.data ?? response }
  }
}

/** Per-session consecutive-failure circuit breaker (agent flail guard). */
export class SessionToolBreaker {
  /** sessionId → consecutive hard failures. */
  private readonly failures = new Map<string, number>()
  /** sessionId → epoch ms until which calls are refused. */
  readonly pausedUntil = new Map<string, number>()

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 10 * 60 * 1000,
    readonly now: () => number = Date.now
  ) {}

  /** Refusal result when the session is paused, else null (call through). */
  check(sessionId: string): FeishuToolResult | null {
    const until = this.pausedUntil.get(sessionId)
    if (!until) return null
    if (this.now() >= until) {
      this.pausedUntil.delete(sessionId)
      this.failures.delete(sessionId)
      return null
    }
    return {
      ok: false,
      error: `该会话的飞书工具已连续失败多次，暂时停止调用（${Math.ceil((until - this.now()) / 60000)} 分钟后恢复）。请停止重试，告知用户到「连接」页检查飞书授权。\n[[connect:feishu]]`
    }
  }

  note(sessionId: string, result: FeishuToolResult): void {
    if (result.ok) {
      this.failures.delete(sessionId)
      return
    }
    // Parameter mistakes are model-fixable; they must not trip the breaker.
    if (typeof result.error === 'string' && result.error.endsWith('不能为空')) return
    const count = (this.failures.get(sessionId) ?? 0) + 1
    if (count >= this.threshold) {
      this.pausedUntil.set(sessionId, this.now() + this.cooldownMs)
      this.failures.delete(sessionId)
    } else {
      this.failures.set(sessionId, count)
    }
  }

  /** Test-only: wipe state between cases. */
  resetForTest(): void {
    this.failures.clear()
    this.pausedUntil.clear()
  }
}

function bitableParams(request: FeishuToolRequest): FeishuToolResult | null {
  if (!string(request.appToken) || !string(request.tableId)) return invalid('appToken 和 tableId 不能为空')
  return null
}

function authorizationRefused(capability: FeishuCapability): FeishuToolResult {
  return {
    ok: false,
    error: `需要额外的飞书授权（${capability}）才能使用这项能力。` + AUTH_GUIDE,
    authorizationRequired: capability
  }
}

export function capabilityFor(action: FeishuToolRequest['action']): FeishuCapability {
  if (action === 'message_send' || action === 'message_reply' || action === 'message_read') return 'messaging'
  // Search runs as the user (their visibility), never as the tenant.
  if (action === 'message_search') return 'search'
  if (action === 'doc_list' || action === 'doc_search') return 'drive'
  if (action === 'doc_read') return 'docs.read'
  if (action === 'doc_create' || action === 'doc_append') return 'docs.write'
  if (action === 'sheets_read') return 'sheets.read'
  if (action === 'sheets_write' || action === 'sheets_create') return 'sheets.write'
  if (action === 'bitable_read' || action === 'bitable_query') return 'bitable.read'
  return 'bitable.write'
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function invalid(error: string): FeishuToolResult {
  return { ok: false, error }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const text = value.replace(/(secret|token|authorization|bearer)[^\s:]*/gi, '$1').slice(0, 300)
  // Auth-class HTTP failures (401/403) get the same stop-and-guide treatment
  // as pre-flight refusals; other transport failures at least ask the agent
  // not to grind on repeated retries.
  if (/status code 40[13]/.test(text)) return `飞书拒绝了这次调用（${text}）。` + AUTH_GUIDE
  return `${text}\n如果连续失败，请停止重试并告知用户检查「连接」页的飞书状态。`
}

function friendlyApiError(response: Record<string, unknown>): string {
  const code = typeof response.code === 'number' ? response.code : 0
  const message = typeof response.msg === 'string' ? response.msg : '飞书暂时无法完成这项操作'
  const permissionDenied = PERMISSION_ERROR_CODES.has(code) || /权限|授权|token|AccessToken/i.test(message)
  const suffix = permissionDenied ? AUTH_GUIDE : '\n如果连续失败，请停止重试并告知用户检查「连接」页的飞书状态。'
  return `${message}（${code}）${suffix}`.slice(0, 400)
}
