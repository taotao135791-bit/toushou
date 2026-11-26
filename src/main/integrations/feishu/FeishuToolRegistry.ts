import { readFile } from 'node:fs/promises'
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
        /* ---------- 原生文档块操作（结构化写入 + 回读验证） ---------- */
        case 'doc_blocks': {
          const documentId = string(request.documentId)
          if (!documentId) return invalid('documentId 不能为空')
          const parent = string(request.parentBlockId) || documentId
          const blocks: Array<Record<string, unknown>> = []
          let pageToken = ''
          // 分页拉取子块清单（回读验证用：块类型/块 ID/纯文本）。
          for (let page = 0; page < 10; page += 1) {
            const params: Record<string, unknown> = { page_size: 200 }
            if (pageToken) params.page_token = pageToken
            const response = await channel.rawClient.request({ method: 'GET', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parent)}/children`, params }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
            const code = typeof response.code === 'number' ? response.code : 0
            if (code !== 0) return { ok: false, error: friendlyApiError(response) }
            const data = response.data as { items?: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean } | undefined
            for (const item of data?.items ?? []) {
              const texts: string[] = []
              for (const key of ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'number', 'quote', 'todo']) {
                const segment = item[key] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined
                for (const element of segment?.elements ?? []) {
                  const content = element.text_run?.content
                  if (content) texts.push(content)
                }
              }
              blocks.push({ block_id: item.block_id, block_type: item.block_type, text: texts.join('') })
            }
            if (data?.has_more && data.page_token) { pageToken = data.page_token; continue }
            break
          }
          return { ok: true, data: { blocks } }
        }
        case 'doc_insert_blocks': {
          const documentId = string(request.documentId)
          if (!documentId) return invalid('documentId 不能为空')
          const blocks = Array.isArray(request.blocks) ? request.blocks : null
          if (!blocks || blocks.length === 0 || blocks.length > 50) return invalid('blocks 必须是 1-50 个块的数组')
          const children: Array<Record<string, unknown>> = []
          for (const block of blocks) {
            const spec = block as { type?: unknown; text?: unknown; level?: unknown }
            const text = typeof spec.text === 'string' ? spec.text : ''
            const level = typeof spec.level === 'number' ? Math.min(9, Math.max(1, Math.floor(spec.level))) : 0
            if (spec.type === 'heading' && level >= 1) {
              children.push({ block_type: 2 + level, ['heading' + level]: { elements: [{ text_run: { content: text } }] } })
            } else if (spec.type === 'bullet') {
              children.push({ block_type: 12, bullet: { elements: [{ text_run: { content: text } }] } })
            } else if (spec.type === 'number') {
              children.push({ block_type: 13, number: { elements: [{ text_run: { content: text } }] } })
            } else if (spec.type === 'quote') {
              children.push({ block_type: 15, quote: { elements: [{ text_run: { content: text } }] } })
            } else {
              children.push({ block_type: 2, text: { elements: [{ text_run: { content: text } }] } })
            }
          }
          const parent = string(request.parentBlockId) || documentId
          const data: Record<string, unknown> = { children }
          if (typeof request.index === 'number') data.index = Math.max(0, Math.floor(request.index))
          const response = await channel.rawClient.request({ method: 'POST', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parent)}/children`, data }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const code = typeof response.code === 'number' ? response.code : 0
          if (code !== 0) return { ok: false, error: friendlyApiError(response) }
          return { ok: true, data: response.data ?? response }
        }
        case 'doc_table_fill': {
          const documentId = string(request.documentId)
          const cells = Array.isArray(request.cells) ? request.cells : null
          if (!documentId || !cells || cells.length === 0) return invalid('documentId 和 cells（二维字符串数组）不能为空')
          const rowCount = cells.length
          const columnCount = Array.isArray(cells[0]) ? (cells[0] as unknown[]).length : 0
          if (rowCount > 100 || columnCount > 20 || columnCount === 0) return invalid('表格行列超出限制')
          const parent = string(request.parentBlockId) || documentId
          const createData: Record<string, unknown> = { children: [{ block_type: 31, table: { property: { row_size: rowCount, column_size: columnCount } } }] }
          if (typeof request.index === 'number') createData.index = Math.max(0, Math.floor(request.index))
          const created = await channel.rawClient.request({ method: 'POST', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parent)}/children`, data: createData }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const createCode = typeof created.code === 'number' ? created.code : 0
          if (createCode !== 0) return { ok: false, error: friendlyApiError(created) }
          const createdData = created.data as { children?: Array<{ block_id?: string }> } | undefined
          const tableBlockId = createdData?.children?.[0]?.block_id
          if (!tableBlockId) return { ok: false, error: '表格块创建成功但未返回块 ID，无法填充单元格' }
          // 表格块创建后每格是空 block：查询格子块 ID，再逐格写入文字。
          const cellsResponse = await channel.rawClient.request({ method: 'GET', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(tableBlockId)}/children`, params: { page_size: 500 } }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const cellsData = cellsResponse.data as { items?: Array<{ block_id?: string }> } | undefined
          const cellIds = (cellsData?.items ?? []).map(item => item.block_id ?? '').filter(Boolean)
          if (cellIds.length < rowCount * columnCount) return { ok: false, error: `表格格子数量不足（期望 ${rowCount * columnCount}，实际 ${cellIds.length}）` }
          let filled = 0
          for (let row = 0; row < rowCount; row += 1) {
            const line = cells[row] as string[]
            for (let column = 0; column < columnCount; column += 1) {
              const cellBlockId = cellIds[row * columnCount + column]
              const content = typeof line[column] === 'string' ? line[column] : ''
              if (!content) { filled += 1; continue }
              const fillConfig = { method: 'POST', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(cellBlockId)}/children`, data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content } }] } }] } }
              const fillResponse = await channel.rawClient.request(fillConfig, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
              const fillCode = typeof fillResponse.code === 'number' ? fillResponse.code : 0
              if (fillCode !== 0) return { ok: false, error: friendlyApiError(fillResponse) + `（第 ${row + 1} 行第 ${column + 1} 列）` }
              filled += 1
            }
          }
          return { ok: true, data: { tableBlockId, rows: rowCount, columns: columnCount, filled } }
        }
        case 'doc_delete_block': {
          const documentId = string(request.documentId)
          const blockId = string(request.blockId)
          // 顶层块父 = 文档 ID；嵌套块（表格格子等）需带 parentBlockId。
          const parentBlockId = string(request.parentBlockId) || documentId
          if (!documentId || !blockId) return invalid('documentId 和 blockId 不能为空')
          const response = await channel.rawClient.request({ method: 'DELETE', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children/${encodeURIComponent(blockId)}` }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined)
          const code = typeof response.code === 'number' ? response.code : 0
          if (code !== 0) return { ok: false, error: friendlyApiError(response) }
          return { ok: true }
        }
        case 'doc_file_attach': {
          const documentId = string(request.documentId)
          const localPath = string(request.localPath)
          if (!documentId || !localPath) return invalid('documentId 和 localPath 不能为空')
          const parent = string(request.parentBlockId) || documentId
          let bytes: Buffer
          try {
            bytes = await readFile(localPath)
          } catch {
            return { ok: false, error: '本地文件不存在或不可读取：' + localPath.slice(0, 200) }
          }
          if (bytes.length === 0) return { ok: false, error: '本地文件是空的（0 字节），无法上传' }
          const name = localPath.split(/[\\/]/).pop() ?? 'attachment'
          // 兼容流程（教程 6.1）：先建空文件块拿内部块 ID → 以内部块为父上传 → 回写 token。
          const createConfig = { method: 'POST', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parent)}/children`, data: { children: [{ block_type: 27, file: {} }] } }
          const created = await channel.rawClient.request(createConfig, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const createCode = typeof created.code === 'number' ? created.code : 0
          if (createCode !== 0) return { ok: false, error: friendlyApiError(created) }
          const createdData = created.data as { children?: Array<{ block_id?: string }> } | undefined
          const fileBlockId = createdData?.children?.[0]?.block_id
          if (!fileBlockId) return { ok: false, error: '文件块创建成功但未返回块 ID' }
          // 媒体上传走 SDK 的 uploadAll（内部正确序列化 multipart；raw request 手拼会 400）。
          const uploader = (channel.rawClient as unknown as {
            drive?: { v1?: { media?: { uploadAll?: (params: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>> } } }
          }).drive?.v1?.media
          if (!uploader?.uploadAll) return { ok: false, error: '当前飞书客户端不支持媒体上传接口' }
          const uploaded = await uploader.uploadAll({ file_name: name, parent_type: 'docx_file', parent_node: fileBlockId, size: bytes.length, file: bytes }, withUserAccessToken(userAccessToken as string)) as Record<string, unknown>
          const uploadCode = typeof uploaded.code === 'number' ? uploaded.code : 0
          if (uploadCode !== 0) return { ok: false, error: friendlyApiError(uploaded) + '（上传失败：若提示权限不足，需要到飞书应用后台补云文档上传 scope 并重新授权）' }
          const uploadData = uploaded.data as { token?: string } | undefined
          const fileToken = uploadData?.token
          if (!fileToken) return { ok: false, error: '媒体上传成功但未返回 file token' }
          const patchConfig = { method: 'PATCH', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(fileBlockId)}`, data: { update_all_fields: true, block_type: 27, file: { token: fileToken } } }
          const patched = await channel.rawClient.request(patchConfig, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const patchCode = typeof patched.code === 'number' ? patched.code : 0
          if (patchCode !== 0) return { ok: false, error: friendlyApiError(patched) + '（file token 回写失败，文件块为空壳）' }
          return { ok: true, data: { fileBlockId, fileToken, fileName: name, size: bytes.length } }
        }
        case 'doc_update_block': {
          const documentId = string(request.documentId)
          const blockId = string(request.blockId)
          const text = typeof request.text === 'string' ? request.text : ''
          if (!documentId || !blockId) return invalid('documentId 和 blockId 不能为空')
          // 先读原块保留其 block_type（只改文字元素，不动块类型）。
          const readResponse = await channel.rawClient.request({ method: 'GET', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}` }, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const readCode = typeof readResponse.code === 'number' ? readResponse.code : 0
          if (readCode !== 0) return { ok: false, error: friendlyApiError(readResponse) }
          const block = (readResponse.data as { block?: Record<string, unknown> } | undefined)?.block
          if (!block || typeof block.block_type !== 'number') return { ok: false, error: '目标块不存在或不可编辑（仅支持文字类块）' }
          const blockType = block.block_type as number
          const textFamilies = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17]
          if (!textFamilies.includes(blockType)) return { ok: false, error: `block_type ${blockType} 不是文字类块，不能这样修改` }
          const familyName = ([, 'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'number', , , 'quote', , , 'todo'])[blockType] ?? 'text'
          const patchConfig = { method: 'PATCH', url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, data: { update_all_fields: true, block_type: blockType, [familyName]: { elements: [{ text_run: { content: text } }] } } }
          const patched = await channel.rawClient.request(patchConfig, userAccessToken ? withUserAccessToken(userAccessToken) : undefined) as Record<string, unknown>
          const patchCode = typeof patched.code === 'number' ? patched.code : 0
          if (patchCode !== 0) return { ok: false, error: friendlyApiError(patched) }
          return { ok: true }
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
  if (action === 'doc_read' || action === 'doc_blocks') return 'docs.read'
  if (action === 'doc_create' || action === 'doc_append') return 'docs.write'
  if (action === 'doc_insert_blocks' || action === 'doc_table_fill' || action === 'doc_delete_block' || action === 'doc_file_attach' || action === 'doc_update_block') return 'docs.write'
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
