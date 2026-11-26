/**
 * Toushou Feishu tools. This package only calls the Main-owned loopback
 * bridge; app secrets and access tokens never enter the OMP tool process.
 */
interface ToolHostApi {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    approval?: 'read' | 'write' | 'exec'
    execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
}

const bridge = process.env.TOUSHOU_FEISHU

async function call(action: string, params: Record<string, unknown>): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '飞书连接工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...params })
    })
    return JSON.stringify(await response.json()).slice(0, 24_000)
  } catch {
    return JSON.stringify({ ok: false, error: '飞书工具暂时不可用' })
  }
}

function register(api: ToolHostApi, name: string, label: string, description: string, properties: Record<string, unknown>, required: string[], approval: 'read' | 'write', action = name): void {
  api.registerTool({
    name,
    label,
    description,
    parameters: { type: 'object', properties, required },
    approval,
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call(action, params ?? {}) }] })
  })
}

export default function feishuTools(api: ToolHostApi): void {
  register(api, 'feishu_message_send', '发送飞书消息', '发送一条飞书消息。发送前请确认聊天对象和内容。', { chatId: { type: 'string' }, content: { type: 'string' } }, ['chatId', 'content'], 'write', 'message_send')
  register(api, 'feishu_message_reply', '回复飞书消息', '回复指定的飞书消息，可保持在原话题内。', { chatId: { type: 'string' }, messageId: { type: 'string' }, content: { type: 'string' }, replyInThread: { type: 'boolean' } }, ['chatId', 'messageId', 'content'], 'write', 'message_reply')
  register(api, 'feishu_message_read', '读取飞书消息', '读取一条飞书消息。', { messageId: { type: 'string' } }, ['messageId'], 'read', 'message_read')
  register(api, 'feishu_message_search', '搜索飞书消息', '在已授权的飞书消息范围内搜索。', { query: { type: 'string' } }, ['query'], 'read', 'message_search')
  register(api, 'feishu_doc_list', '列出飞书云文档', '按最近编辑时间列出用户云空间根目录的文档。返回结果里的 token 可作为 feishu_doc_read 的 documentId。', { }, [], 'read', 'doc_list')
  register(api, 'feishu_doc_search', '搜索飞书文档', '按关键词搜索用户可见的飞书文档。部分应用版本不支持搜索，失败时请改用 feishu_doc_list。返回结果里的 token 可作为 feishu_doc_read 的 documentId。', { query: { type: 'string' } }, ['query'], 'read', 'doc_search')
  register(api, 'feishu_doc_read', '读取飞书文档', '读取飞书文档内容。需要用户身份权限时会提示按需授权。', { documentId: { type: 'string' } }, ['documentId'], 'read', 'doc_read')
  register(api, 'feishu_doc_create', '创建飞书文档', '创建一篇飞书文档。', { title: { type: 'string' } }, ['title'], 'write', 'doc_create')
  register(api, 'feishu_doc_append', '追加飞书文档', '向飞书文档追加内容。', { documentId: { type: 'string' }, content: { type: 'string' } }, ['documentId', 'content'], 'write', 'doc_append')
  register(api, 'feishu_sheets_read', '读取飞书表格', '读取飞书表格范围。', { spreadsheetToken: { type: 'string' }, range: { type: 'string' } }, ['spreadsheetToken', 'range'], 'read', 'sheets_read')
  register(api, 'feishu_sheets_write', '写入飞书表格', '写入飞书表格范围。', { spreadsheetToken: { type: 'string' }, range: { type: 'string' }, values: { type: 'array' } }, ['spreadsheetToken', 'range', 'values'], 'write', 'sheets_write')
  register(api, 'feishu_sheets_create', '创建飞书表格', '创建一个飞书电子表格。', { title: { type: 'string' } }, ['title'], 'write', 'sheets_create')
  register(api, 'feishu_bitable_read', '读取多维表格记录', '读取飞书多维表格记录。', { appToken: { type: 'string' }, tableId: { type: 'string' } }, ['appToken', 'tableId'], 'read', 'bitable_read')
  register(api, 'feishu_bitable_upsert', '写入多维表格记录', '创建一条飞书多维表格记录。', { appToken: { type: 'string' }, tableId: { type: 'string' }, fields: { type: 'object' } }, ['appToken', 'tableId', 'fields'], 'write', 'bitable_upsert')
  register(api, 'feishu_bitable_query', '查询多维表格', '按过滤条件查询飞书多维表格。', { appToken: { type: 'string' }, tableId: { type: 'string' }, filter: { type: 'object' } }, ['appToken', 'tableId'], 'read', 'bitable_query')
  register(api, 'feishu_doc_blocks', '读取文档块结构', '读取飞书文档的子块清单（块 ID/类型/文本），用于写入后回读验证和定位插入位置。', { documentId: { type: 'string' }, parentBlockId: { type: 'string' } }, ['documentId'], 'read', 'doc_blocks')
  register(api, 'feishu_doc_insert_blocks', '在指定位置插入内容块', '在文档的指定位置插入标题/段落/列表块。blocks 元素形如 { type: heading|bullet|number|quote|text, level?: 1-9, text }，可携 index 控制插入位置。写入后建议用 feishu_doc_blocks 回读验证。', { documentId: { type: 'string' }, parentBlockId: { type: 'string' }, index: { type: 'number' }, blocks: { type: 'array' } }, ['documentId', 'blocks'], 'write', 'doc_insert_blocks')
  register(api, 'feishu_doc_table_fill', '创建飞书原生表格并填充', '在文档中创建原生表格并填充全部单元格。cells 为二维字符串数组，第一行作为表头。填充完成后请用 feishu_doc_blocks 回读验证。', { documentId: { type: 'string' }, parentBlockId: { type: 'string' }, index: { type: 'number' }, cells: { type: 'array' } }, ['documentId', 'cells'], 'write', 'doc_table_fill')
  register(api, 'feishu_doc_delete_block', '删除飞书文档块', '删除指定的块（清理测试块/重复内容用）。嵌套块（表格格子等）需另带 parentBlockId。', { documentId: { type: 'string' }, blockId: { type: 'string' }, parentBlockId: { type: 'string' } }, ['documentId', 'blockId'], 'write', 'doc_delete_block')
  register(api, 'feishu_doc_file_attach', '把本地文件作为可预览附件插入文档', '上传本地文件并以飞书原生文件块插入文档（可预览）。上传前先确认本地文件存在且非空文件。', { documentId: { type: 'string' }, parentBlockId: { type: 'string' }, localPath: { type: 'string' } }, ['documentId', 'localPath'], 'write', 'doc_file_attach')
}
