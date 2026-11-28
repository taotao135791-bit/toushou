/**
 * 投手长期记忆工具。只调用 Main 拥有的回环桥（TOUSHOU_MEMORY）：
 * 记忆的存取与项目隔离全部由 Main 裁决，工具层看不到别的项目的数据。
 * - toushou_memory_save：把用户让"记住"的内容落盘（scope 默认本项目）；
 * - toushou_memory_list / update / delete：查询本项目和全局记忆，确认后改写或删除；
 * - toushou_session_search / toushou_session_read：在当前项目的历史对话里检索。
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

const bridge = process.env.TOUSHOU_MEMORY
const entryId = { type: 'string', minLength: 1, maxLength: 64, description: '记忆查询返回的条目 ID' }
const entryScope = { type: 'string', enum: ['project', 'global'], description: '以记忆查询返回的 scope 为准' }
const mutationResultGuidance =
  '等待投手主进程显示并取得用户确认，只在返回 ok:true 时报告成功。' +
  '若返回 user-declined、cancelled 或 memory-disabled，如实告知并停止；' +
  '若返回 stale-entry，告知条目已变更，重新查询供用户核对；' +
  '若返回 result-unknown，说明结果未确认，可查询当前状态。以上情况均不要自动重试写入。'

async function call(params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '记忆工具只在投手桌面端内可用' })
  const isMutation = params.action === 'memory_update' || params.action === 'memory_delete'
  if (isMutation && signal?.aborted) return JSON.stringify({ ok: false, error: 'cancelled' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal
    })
    return JSON.stringify(await response.json())
  } catch {
    if (isMutation) return JSON.stringify({ ok: false, error: 'result-unknown' })
    return JSON.stringify({ ok: false, error: '记忆服务暂时不可用' })
  }
}

export default function memoryTools(api: ToolHostApi): void {
  api.registerTool({
    name: 'toushou_memory_save',
    label: '记住',
    description:
      '把用户明确要求「记住/以后都这样/长期有效」的内容写入长期记忆，跨对话生效。' +
      '默认 scope=project（只对当前项目生效）；scope=global 表示所有项目都生效（只用于产品级通用规矩，如数据口径、安全红线，不用于某个项目/客户的具体事实）。' +
      '只在用户表达了「记住」意图时调用，不要主动记录闲聊；一条记忆一句话写结论不写过程；已有同类记忆时不要重复保存。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 2000, description: '要记住的一句话结论，例如「AF 数据必须直连，禁止走代理」' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project=只当前项目（默认）；global=所有项目' }
      },
      required: ['text'],
      additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_save', text: params.text, scope: params.scope ?? 'project' }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_list',
    label: '查找长期记忆',
    description:
      '查询全局和当前项目的长期记忆，可按内容关键词和范围筛选。返回条目 ID、范围、文字预览和更新时间。' +
      '改写或删除前先用它定位条目；翻页时把返回的 nextCursor 原样传入，保持原查询和范围。memory-disabled 表示长期记忆已关闭。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 120, description: '可选：要查找的文字关键词' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], description: '可选：all 为全局和当前项目（默认）' },
        cursor: { type: 'string', minLength: 1, maxLength: 256, description: '可选：上一页返回的 nextCursor' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '可选：每页最多返回的条目数量' }
      },
      additionalProperties: false
    },
    approval: 'read',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({
        action: 'memory_list', query: params.query, scope: params.scope ?? 'all', cursor: params.cursor, limit: params.limit
      }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_update',
    label: '改写长期记忆',
    description:
      '用户要求纠正一条长期记忆时，先用 toushou_memory_list 核对条目，再传原条目的 ID、范围和完整替换文字。' +
      mutationResultGuidance,
    parameters: {
      type: 'object',
      properties: {
        id: entryId,
        scope: entryScope,
        text: { type: 'string', minLength: 1, maxLength: 2000, description: '完整的新记忆文字' }
      },
      required: ['id', 'scope', 'text'],
      additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({
        action: 'memory_update', id: params.id, scope: params.scope, text: params.text
      }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_delete',
    label: '删除长期记忆',
    description:
      '用户明确要删除一条长期记忆时，先用 toushou_memory_list 核对条目，再传该条目的 ID 和范围。' +
      mutationResultGuidance,
    parameters: {
      type: 'object',
      properties: { id: entryId, scope: entryScope },
      required: ['id', 'scope'],
      additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_delete', id: params.id, scope: params.scope }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_session_search',
    label: '搜历史对话',
    description:
      '在项目的历史对话里检索信息（按标题过滤 + 关键词全文搜索），返回命中的对话标题、时间和片段。' +
      '默认只搜当前项目；用户明确要求找别的项目的内容时，传 projectName（会向用户弹确认，拒绝则停止并告知）。' +
      '用于回答「之前说的 X 是什么/上次聊到 Y」这类回溯问题：先给 titleWords/days 缩小范围，命中后用 toushou_session_read 读上下文再回答。' +
      '找到用户可能想长期保留的信息时，可以问一句是否用 toushou_memory_save 记下来。',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 60 }, description: '要在对话内容里找的关键词（1-5 个）' },
        titleWords: { type: 'string', maxLength: 60, description: '可选：按对话标题过滤（如「文案」「看板」）' },
        days: { type: 'integer', minimum: 1, maximum: 365, description: '可选：只看最近 N 天修改过的对话' },
        projectName: { type: 'string', maxLength: 120, description: '可选：跨项目检索时填目标项目名（名称的一部分即可，如「投手工作区」）；只在用户明确要求跨项目时使用，会弹用户确认' }
      },
      required: ['keywords'],
      additionalProperties: false
    },
    approval: 'read',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'session_search', ...params }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_session_read',
    label: '读历史对话片段',
    description:
      '按 uuid 读取 toushou_session_search 命中的老对话内容（可选围绕某关键词截取上下文），用于回答关于过去对话的具体问题。默认只读当前项目；用户明确要求时传 projectName 读别的项目（会弹用户确认）。',
    parameters: {
      type: 'object',
      properties: {
        uuid: { type: 'string', maxLength: 80, description: 'toushou_session_search 返回的对话 uuid' },
        keyword: { type: 'string', maxLength: 60, description: '可选：只读该关键词附近的上下文' },
        projectName: { type: 'string', maxLength: 120, description: '可选：跨项目读取时填目标项目名；只在用户明确要求时使用，会弹用户确认' }
      },
      required: ['uuid'],
      additionalProperties: false
    },
    approval: 'read',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'session_read', ...params }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_all_projects',
    label: '查全部记忆',
    description:
      '回答「你还记得之前记过什么/都有哪些记忆」：返回全局记忆、当前项目记忆，以及其他项目的记忆。' +
      '其他项目的记忆会向用户弹一次确认（项目记忆默认隔离，用户点头才给）。只读，不写入。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    approval: 'read',
    execute: async (_id, _params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_all_projects' }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_search_projects',
    label: '跨项目搜记忆',
    description:
      '按项目名在另一个项目的记忆里找条目（如用户说「去投手工作区的记忆里找预算那条」）。' +
      '会向用户弹确认（项目记忆默认隔离，用户点头才返回）。搜索当前项目记忆请用 toushou_memory_list。',
    parameters: {
      type: 'object',
      properties: {
        projectName: { type: 'string', maxLength: 120, description: '目标项目名（名称的一部分即可，如「投手工作区」）' },
        keywords: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 60 }, description: '记忆文本关键词（1-5 个，任一命中即返回）' }
      },
      required: ['projectName', 'keywords'],
      additionalProperties: false
    },
    approval: 'read',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_search_projects', ...params }, signal) }]
    })
  })
}
