/**
 * 投手长期记忆工具。只调用 Main 拥有的回环桥（TOUSHOU_MEMORY）：
 * 记忆的存取与项目隔离全部由 Main 裁决，工具层看不到别的项目的数据。
/**
 * - toushou_memory_save：把用户让"记住"的内容落盘（scope 默认本项目）；
 * - toushou_memory_list / update / delete：查看、改写、删除已有记忆
 *   （改写/删除会向用户弹确认，展示原文）；
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

async function call(params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '记忆工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal
    })
    return JSON.stringify(await response.json())
  } catch {
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
    label: '查看记忆清单',
    description:
      '查看当前生效的长期记忆（全局 + 本项目，每条含 id、内容、时间）。改写或删除某条记忆前，先用它拿到该条的准确 id 和所在 scope。只读，不弹确认。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    approval: 'read',
    execute: async (_id, _params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_list' }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_update',
    label: '改写记忆',
    description:
      '把一条已有记忆改写成新内容（用户说「那条不对了/以后改成…」时用）。必须先用 toushou_memory_list 拿到该条的 id 和 scope。' +
      '会向用户弹确认（展示原文与新文）；用户拒绝则如实转告，不要重试。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 80, description: 'toushou_memory_list 返回的条目 id' },
        text: { type: 'string', maxLength: 2000, description: '改写后的完整新内容（一句话结论）' },
        scope: { type: 'string', enum: ['project', 'global'], description: '该条所在的层（以 list 返回为准，默认 project）' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_update', id: params.id, text: params.text, scope: params.scope ?? 'project' }, signal) }]
    })
  })

  api.registerTool({
    name: 'toushou_memory_delete',
    label: '删除记忆',
    description:
      '删除一条已有记忆（用户明确说「忘掉那条/删了它」时用）。必须先用 toushou_memory_list 拿到该条的 id 和 scope。' +
      '会向用户弹确认（展示将删除的原文）；用户拒绝则如实转告，不要重试。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 80, description: 'toushou_memory_list 返回的条目 id' },
        scope: { type: 'string', enum: ['project', 'global'], description: '该条所在的层（以 list 返回为准，默认 project）' }
      },
      required: ['id'],
      additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params, signal) => ({
      content: [{ type: 'text', text: await call({ action: 'memory_delete', id: params.id, scope: params.scope ?? 'project' }, signal) }]
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
      '会向用户弹确认（项目记忆默认隔离，用户点头才返回）。搜索当前项目记忆请改用 toushou_memory_all_projects 的 currentProject 部分。',
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
