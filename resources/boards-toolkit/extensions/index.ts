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
    // Main already returns bounded JSON with explicit truncation metadata;
    // slicing here would corrupt JSON and hide a large account scope.
    return JSON.stringify(await response.json())
  } catch {
    return JSON.stringify({ ok: false, error: '看板工具暂时不可用' })
  }
}

const WIDGET_TYPES = [
  'clock', 'note', 'counter', 'fb-reading', 'fb-reading-summary', 'fb-report-reading',
  'google-report-reading', 'tt-reading', 'reading-module', 'gauge', 'chart-line', 'chart-bar', 'todo', 'link', 'file'
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
    description: '查看一块看板的结构。普通看板返回组件配置；读数快照看板返回有界的所选账户摘要和证据引用，包含账户名称及 ID。' +
      '\n仅当用户要求从已保存快照提议对话高光时，读取 reading-snapshot 组件 config.evidence：boardId、widgetId、revision 与 accounts（最多50个账户及序号）。' +
      '每条观察只能引用状态 ok 且 sourceAt 非空的账户和非空 metrics 值；金额须有币种，上期消耗须有对应前期窗口。失败、未知、已省略账户不得引用。' +
      '同一观察不要跨平台、跨币种金额或不同日期比较；不要推断因果。' +
      '\n用一个 ```board-highlights JSON 代码块提议：{"version":1,"boardId":"...","widgetId":"...","revision":"sha256:...","highlights":[{"text":"供人工审核的观察","evidence":[{"accountIndex":1,"metric":"spend","value":123}]}]}。' +
      'accountIndex 使用 evidence.accounts 的 index，metric 仅可为 spend、previousSpend、impressions、clicks、conversions，value 必须与对应数字完全一致；示例 123 必须替换为实际证据。' +
      '可包含账户名和账户 ID；不要包含网址或额外字段，不要编造空值；如果无证据则解释缺口，不输出该代码块。高光文本由用户审核，引用数字经应用校验但不代表自然语言结论已验证；禁止声称已自动应用或已修改广告。' +
      '新快照只能由用户在读数界面保存，不能由模型凭空创建。',
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
      '新建本机看板并回报结果；需要确认时等待用户批准，不触碰广告平台。\n' +
      '用户没提具体要求时按模板标配建：\n' +
      Object.entries(TEMPLATE_HELP).map(([id, help]) => `- ${id}：${help}`).join('\n') +
      '\n用户指定 TikTok 广告主时，必须先通过 TikTok 连接信息查询其数字 ID，并以逗号分隔的字符串传 advertiserIds；不知道 ID 时先查明或请用户提供，不能留空代替指定范围。未指定账户时留空会读取连接页所选账户，未选择时读取授权账户。' +
      '\n建板返回 datasetReady=false 时，立即调用 touhou_tiktok_update 拉取报表（需要已连接 TikTok），指标卡和趋势图会自动填充，然后如实向用户汇报。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '看板名称，如 "miclip"；缺省用模板名' },
        template: { type: 'string', enum: TEMPLATES, description: '标准模板，缺省 tiktok' },
        description: { type: 'string', description: '可选看板说明' },
        advertiserIds: { type: 'string', description: '指定账户时必填：数字广告主 ID 字符串，多个 ID 用逗号分隔；读数与数据卡都按这些 ID 筛选。' },
        advertiserName: { type: 'string', description: '可选显示名称；提供名称时也必须提供对应 advertiserIds，数据卡按 ID 而不是名称筛选。' },
        advertiserNames: {
          type: 'array',
          description:
            '可选显示名称数组，必须同时提供对应 advertiserIds。先从 TikTok 授权账户中核实 ID；读数与数据卡均按 ID 筛选。币种不同时金额合计卡会显示 — 并标 MIX，计数指标正常合计。'
        }
      },
      required: []
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_create', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_add_widget',
    label: '看板加组件',
    description: '向已有看板添加一个组件（自动找空位；配置不合法会被整体拒绝，不会弄坏看板）。展示读数时使用独立 reading-module 指标、图表、说明组件，避免将整页挤入小卡。先 board_get 获取已保存的 reading-snapshot 或 reading-module 的 boardId 和 widgetId，再通过 source 引用；不能自己提供或伪造 snapshot。config 仅传 module：kind 为 metric、spend-chart、coverage 或 note；metric 必须传 metric（spend、impressions、clicks、conversions）及从 0 开始的 accountIndex；spend-chart 传 chart（bar、pie、donut）；note 传 text。数据是保存时的快照，不是实时数据；不要混合币种或伪造时间趋势。layout 的 w 范围 1–12、h 范围 1–20。',
    parameters: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        type: { type: 'string', enum: WIDGET_TYPES },
        title: { type: 'string', description: '可选：组件标题' },
        config: { type: 'object', description: '可选：组件配置；reading-module 仅提供 module，不提供 snapshot。' },
        source: { type: 'object', properties: { boardId: { type: 'string' }, widgetId: { type: 'string' } }, required: ['boardId', 'widgetId'], description: 'reading-module 必填，现有保存的读数来源。' },
        layout: { type: 'object', properties: { w: { type: 'integer', minimum: 1, maximum: 12 }, h: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['w', 'h'], description: '可选网格尺寸。' }
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

  api.registerTool({
    name: 'toushou_dataset_import',
    label: '导入看板数据集',
    description:
      '把一个 CSV/XLSX 文件导入为看板数据集（文件须位于当前会话的授权工作区；列结构自动识别）。\n' +
      '关键用法：name 传「TikTok 报表」时为替换式导入——模板看板的指标卡/趋势图都按这个名字绑定，导入完成后整块看板立即点亮。' +
      '本工具只用于导入用户明确提供的报表文件；TikTok 数据的获取一律走 touhou_tiktok_update（MCP），它失败就如实报错，禁止用 CSV/文件/computer use 绕路。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '当前会话已授权工作区内的 CSV/XLSX 路径' },
        name: { type: 'string', description: '目标数据集名称；传「TikTok 报表」为替换式导入' }
      },
      required: ['filePath']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'dataset_import', ...params }) }] })
  })
}
