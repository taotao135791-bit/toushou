import { FeishuCapability, FeishuToolRequest, FeishuToolResult } from '../../../shared/connections'
import { withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { FeishuChannel } from './FeishuChannel'

type RawClient = FeishuChannel['rawClient']

/**
 * Small, agent-oriented Feishu tool surface. It deliberately exposes high
 * level operations instead of forwarding arbitrary Open API URLs.
 */
export class FeishuToolRegistry {
  constructor(
    private readonly getChannel: () => FeishuChannel | null,
    private readonly isCapabilityAuthorized: (capability: FeishuCapability) => boolean,
    private readonly getUserAccessToken?: (capability: FeishuCapability) => Promise<string | null>
  ) {}

  async execute(request: FeishuToolRequest): Promise<FeishuToolResult> {
    const capability = capabilityFor(request.action)
    if (!this.isCapabilityAuthorized(capability)) {
      return { ok: false, error: '需要额外授权才能使用这项飞书能力。', authorizationRequired: capability }
    }
    const channel = this.getChannel()
    if (!channel) return { ok: false, error: '飞书尚未连接。' }
    try {
      const userAccessToken = capability === 'messaging' ? null : await this.getUserAccessToken?.(capability)
      if (capability !== 'messaging' && !userAccessToken) {
        return { ok: false, error: '需要重新授权才能使用这项飞书能力。', authorizationRequired: capability }
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
        case 'message_read':
          return await this.request(channel.rawClient, 'GET', `/open-apis/im/v1/messages/${encodeURIComponent(string(request.messageId))}`, {}, userAccessToken)
        case 'message_search':
          return await this.request(channel.rawClient, 'POST', '/open-apis/search/v2/message', { data: { query: string(request.query).slice(0, 200), page_size: 20 } }, userAccessToken)
        case 'doc_read':
          return await this.request(channel.rawClient, 'GET', `/open-apis/docx/v1/documents/${encodeURIComponent(string(request.documentId))}/raw_content`, {}, userAccessToken)
        case 'doc_create':
          return await this.request(channel.rawClient, 'POST', '/open-apis/docx/v1/documents', { data: { title: string(request.title).slice(0, 100) } }, userAccessToken)
        case 'doc_append':
          return await this.request(channel.rawClient, 'POST', `/open-apis/docx/v1/documents/${encodeURIComponent(string(request.documentId))}/blocks/${encodeURIComponent(string(request.documentId))}/children`, {
            data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: string(request.content).slice(0, 20_000) } }] } }] }
          }, userAccessToken)
        case 'sheets_read':
          return await this.request(channel.rawClient, 'GET', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(string(request.spreadsheetToken))}/values/${encodeURIComponent(string(request.range))}`, {}, userAccessToken)
        case 'sheets_write':
          return await this.request(channel.rawClient, 'PUT', `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(string(request.spreadsheetToken))}/values`, {
            data: { valueRange: { range: string(request.range), values: Array.isArray(request.values) ? request.values : [] } }
          }, userAccessToken)
        case 'sheets_create':
          return await this.request(channel.rawClient, 'POST', '/open-apis/sheets/v3/spreadsheets', { data: { title: string(request.title).slice(0, 100) } }, userAccessToken)
        case 'bitable_read':
          return await this.request(channel.rawClient, 'GET', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records`, { params: { page_size: 100 } }, userAccessToken)
        case 'bitable_upsert':
          return await this.request(channel.rawClient, 'POST', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records`, { data: { fields: request.fields ?? {} } }, userAccessToken)
        case 'bitable_query':
          return await this.request(channel.rawClient, 'POST', `/open-apis/bitable/v1/apps/${encodeURIComponent(string(request.appToken))}/tables/${encodeURIComponent(string(request.tableId))}/records/search`, { data: { filter: request.filter, page_size: 100 } }, userAccessToken)
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

export function capabilityFor(action: FeishuToolRequest['action']): FeishuCapability {
  if (action === 'message_send' || action === 'message_reply') return 'messaging'
  if (action === 'message_read' || action === 'message_search') return 'messaging'
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
  return value.replace(/(secret|token|authorization|bearer)[^\s:]*/gi, '$1').slice(0, 300)
}

function friendlyApiError(response: Record<string, unknown>): string {
  const code = typeof response.code === 'number' ? `（${response.code}）` : ''
  const message = typeof response.msg === 'string' ? response.msg : '飞书暂时无法完成这项操作'
  return `${message}${code}`.slice(0, 300)
}
