/**
 * Toushou boards tools. This package only calls the Main-owned loopback
 * bridge; board storage never leaves the app. Boards are the LOCAL canvas:
 * the agent may list, inspect, create and reshape them directly and report
 * back. The ad platforms themselves stay strictly read-only — no tool here
 * can adjust, create or delete actual ad content, ever.
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

const bridge = process.env.TOUSHOU_BOARDS

async function call(params: Record<string, unknown>): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '看板工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    })
    return JSON.stringify(await response.json()).slice(0, 24_000)
  } catch {
    return JSON.stringify({ ok: false, error: '看板工具暂时不可用' })
  }
}

const WIDGET_TYPES = [
  'clock', 'note', 'counter', 'fb-reading', 'fb-reading-summary', 'fb-report-reading',
  'google-report-reading', 'tt-reading', 'gauge', 'chart-line', 'chart-bar', 'todo', 'link', 'file'
]

const TEMPLATES = ['tiktok', 'fb-daily', 'fb-daily-v2', 'ads', 'daily', 'blank']

/** 标准看板模板说明，教助手"没提要求也给出标配"。 */
const TEMPLATE_HELP = {
  tiktok: 'TikTok 投放全景：总消耗/总点击/平均点击率/总转化四个指标卡 + 近 30 天消耗趋势 + 分活动消耗对比 + 转化趋势 + TT 读数模块。指标卡与图表绑定「TikTok 报表」数据集。',
  'fb-daily': 'FB 投放日报：跨账户读数汇总 + 每账户明细卡（需要用户已登记 FB 账户）。',
  'fb-daily-v2': 'FB 报表读数：导入 Facebook 报表 CSV 并核验。',
  ads: '海外广告投放（占位演示数据）：KPI 行 + 趋势 + 渠道对比 + 预算 + 清单。',
  daily: '日常通用：时钟 + 便签 + 待办。',
  blank: '空白看板。'
}

export default function boardsTools(api: ToolHostApi): void {
  api.registerTool({
    name: 'toushou_boards_list',
    label: '列出看板',
    description:
      '列出投手的全部看板（名称/组件数/是否锁定）和看板数据集概况（名称/行数/列结构）。' +
      '用户问"我有哪些看板""miclip 的数据在哪"这类问题时先用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    approval: 'read',
    execute: async () => ({ content: [{ type: 'text', text: await call({ action: 'boards_list' }) }] })
  })

  api.registerTool({
    name: 'toushou_board_get',
    label: '查看看板',
    description: '查看一块看板的完整结构：每个组件的类型、标题和配置（读数模块的账户/日期口径、图表的数据集绑定等）。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: '看板 ID（与 name 二选一）' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' }
      },
      required: []
    },
    approval: 'read',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_get', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_create',
    label: '新建看板',
    description:
      '直接新建一块看板并回报结果（本机画布操作，无需用户确认；但绝不触碰广告平台）。\n' +
      '用户没提具体要求时按模板标配建：\n' +
      Object.entries(TEMPLATE_HELP).map(([id, help]) => `- ${id}：${help}`).join('\n') +
      '\n用户提到 TikTok 广告主（如"看 miclip 数据"）时传 advertiserIds（逗号分隔；不知道 ID 就先用 toushou_boards_list 或连接信息查询，或留空让模块读取全部授权广告主）。' +
      '\n建板返回 datasetReady=false 时，立即调用 touhou_tiktok_update 拉取报表（需要已连接 TikTok），指标卡和趋势图会自动填充，然后如实向用户汇报。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '看板名称，如 "miclip"；缺省用模板名' },
        template: { type: 'string', enum: TEMPLATES, description: '标准模板，缺省 tiktok' },
        description: { type: 'string', description: '可选看板说明' },
        advertiserIds: { type: 'string', description: '可选：TikTok 广告主 ID（逗号分隔），绑定 TT 读数模块' }
      },
      required: []
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_create', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_add_widget',
    label: '看板加组件',
    description: '向已有看板添加一个组件（自动找空位；配置不合法会被整体拒绝，不会弄坏看板）。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        type: { type: 'string', enum: WIDGET_TYPES },
        title: { type: 'string', description: '可选：组件标题' },
        config: { type: 'object', description: '可选：组件配置（与界面上手动配置的字段一致）' }
      },
      required: ['type']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_add_widget', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_remove_widget',
    label: '看板删组件',
    description: '从看板移除一个组件（先用 toushou_board_get 拿到 widgetId）。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        widgetId: { type: 'string' }
      },
      required: ['widgetId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_remove_widget', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_update_widget',
    label: '看板改组件',
    description: '修改看板组件的标题或配置（config 为增量合并，改完整体校验）。改看板名用 toushou_board_rename。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        widgetId: { type: 'string' },
        title: { type: 'string', description: '可选：新标题' },
        config: { type: 'object', description: '可选：要覆盖的配置字段' }
      },
      required: ['widgetId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_update_widget', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_rename',
    label: '看板改名',
    description: '重命名一块看板（不能与其他看板重名）。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string', description: '当前看板名称（与 boardId 二选一）' },
        newName: { type: 'string' }
      },
      required: ['newName']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_rename', ...params }) }] })
  })
}
