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
  'google-report-reading', 'tt-reading', 'meta-reading', 'reading-module', 'gauge', 'chart-line', 'chart-bar', 'table', 'funnel', 'analysis', 'todo', 'link', 'file'
]

const TEMPLATES = ['meta', 'tiktok', 'fb-daily-v2', 'ads', 'daily', 'blank']
const GRANULARITIES = ['account', 'campaign', 'adgroup', 'ad', 'creative']

const BUILD_ID = { type: 'string', description: 'board_build_begin返回的本次buildId；生成期间每次读写必须携带，不能复用旧轮次ID' }
const HEX_COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }
const CANVAS_STYLE = { type: 'object', properties: { background: HEX_COLOR, grid: { type: 'string', enum: ['none', 'dots', 'lines'] } }, additionalProperties: false }
const WIDGET_STYLE = {
  type: 'object',
  properties: {
    accent: HEX_COLOR, surface: HEX_COLOR, text: HEX_COLOR, border: HEX_COLOR,
    radius: { type: 'integer', minimum: 0, maximum: 32 }, padding: { type: 'integer', minimum: 6, maximum: 32 },
    titleAlign: { type: 'string', enum: ['left', 'center', 'right'] }, shadow: { type: 'string', enum: ['none', 'soft', 'strong'] }
  },
  additionalProperties: false
}
const GRID_FIELDS = { x: { type: 'integer', minimum: 0, maximum: 11 }, y: { type: 'integer', minimum: 0 }, w: { type: 'integer', minimum: 1, maximum: 12 }, h: { type: 'integer', minimum: 1, maximum: 20 } }
const FULL_LAYOUT = { type: 'object', properties: GRID_FIELDS, required: ['x', 'y', 'w', 'h'], additionalProperties: false }
const MASTER_SCOPE = {
  type: 'object',
  properties: { range: { type: 'string', enum: ['yesterday', 'today', 'last3', 'last7', 'last30'] }, metrics: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', enum: ['spend', 'cpi', 'cpm', 'ctr', 'cpa', 'balance'] } } },
  required: ['range', 'metrics'], additionalProperties: false
}
const DATE_SCOPE = {
  anyOf: [
    { type: 'object', properties: { mode: { const: 'inherit' } }, required: ['mode'], additionalProperties: false },
    { type: 'object', properties: { mode: { const: 'lookback' }, days: { type: 'integer', minimum: 1, maximum: 30 }, anchor: { const: 'reportEnd' } }, required: ['mode', 'days', 'anchor'], additionalProperties: false },
    { type: 'object', properties: { mode: { const: 'absolute' }, start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } }, required: ['mode', 'start', 'end'], additionalProperties: false }
  ],
  description: '模块日期：省略或inherit跟随报表；lookback以报表截止日向前取days天；absolute固定历史日期且仍可刷新。昨日日报中的七日趋势用lookback/days:7/anchor:reportEnd，不改变日报主范围。'
}

/** 标准看板模板，仅在用户明确要求时选择。 */
const TEMPLATE_HELP = {
  meta: 'Meta Ads 原生读数：meta-reading 经 Main 调用只读 MCP，选择已授权账户、随总控切换日期、刷新并联动指标及每日趋势。',
  tiktok: 'TikTok 常用起点：媒体指标、按日趋势、分活动对比和 TT 读数模块；指标和图表绑定「TikTok 报表」。可按任务调整组合与顺序，日期沿用总控。',
  'fb-daily-v2': 'FB 投放日报：按产品关联已保存报表，自动获取并核验报表读数。',
  ads: '海外广告投放（占位演示数据）：KPI 行 + 趋势 + 渠道对比 + 预算 + 清单。',
  daily: '日常通用：时钟 + 便签 + 待办。',
  blank: '空白看板。'
}

export default function boardsTools(api: ToolHostApi): void {
  for (const operation of [
    { action: 'board_build_begin', label: '准备看板', approval: 'read' as const, description: '生成或修改看板前先调用。应用依据当前真实用户消息冻结任务要求，并创建本次私有草稿；仅修改已有板时传targetBoardId。不要重述或自行降级用户要求。返回buildId、要求、数据范围及后续步骤。草稿不会出现在正式看板列表；只是查询已有看板不需要开始生成。', properties: { targetBoardId: { type: 'string', description: '仅修改现有看板时传其真实ID；新建时省略' } }, required: [] as string[] },
    { action: 'board_build_status', label: '查看看板进度', approval: 'read' as const, description: '查看本次看板草稿、冻结的用户要求与数据缺口。不能通过修改check参数降低本次要求。', properties: { buildId: { type: 'string' } }, required: [] as string[] },
    { action: 'board_build_preflight', label: '核对看板数据', approval: 'read' as const, description: '按应用保存的原始任务要求核对本次草稿及真实数据，返回缺口。优先确认所需粒度、ID、指标、日期历史和来源绑定；缺少数据时报告具体缺口，不把活动级数据替代用户指定的素材/广告级。接口能力和当前缓存列分开核对，不从一张活动表推断整个平台不支持广告。未通过不得交付成品。', properties: { buildId: { type: 'string' } }, required: ['buildId'] },
    { action: 'board_build_commit', label: '保存看板', approval: 'write' as const, description: '将本次已完成草稿验收后整体保存为正式看板。应用再次按冻结的原始要求、实际数据、日期和已有板版本验收；模型无法通过省略required/granularity绕过。只有成功且published:true才可报告已保存并给正式看板入口。失败保留草稿，不能另建默认替代板或宣称已完成。返回conflict时先abort旧草稿，再begin回读新版本重新应用本次修改，不反复提交过期buildId。', properties: { buildId: { type: 'string' } }, required: ['buildId'] },
    { action: 'board_build_abort', label: '取消看板草稿', approval: 'read' as const, description: '放弃本次未发布的看板草稿，保留原有看板与数据。用户取消或明确改任务时使用，不删除正式板。', properties: { buildId: { type: 'string' } }, required: ['buildId'] }
  ]) {
    api.registerTool({ name: `toushou_${operation.action}`, label: operation.label, description: operation.description,
      parameters: { type: 'object', properties: operation.properties, required: operation.required, additionalProperties: false },
      approval: operation.approval,
      execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: operation.action }) }] })
    })
  }
  api.registerTool({
    name: 'toushou_board_meta_accounts', label: '查看 Meta 账户',
    description: '通过现有 Meta 连接只读列出已授权账户，供新建或设置原生Meta看板时选择。只使用当前任务明确指定的账户；有多个同样适用的账户时简短询问，不随意选择第一项。把确认的真实账户ID写入meta-reading组件config.accountId，随后board_refresh真实取数。未连接或没有权限时说明实际缺口。此工具不会新建看板或修改广告。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, approval: 'read',
    execute: async () => ({ content: [{ type: 'text', text: await call({ action: 'board_meta_accounts' }) }] })
  })
  api.registerTool({
    name: 'toushou_board_refresh', label: '刷新看板数据',
    description: '按看板保存的配置统一刷新媒体与三方数据。只传boardId，应用一次计算报表及各模块的实际日期、安排查询并返回本次结果，模型不要逐个计算日期。新建/修改时先开始草稿、保存查询绑定和组件，再刷新当前草稿；只有数据完成且草稿commit成功才交付。七日趋势与昨日指标可有各自窗口；失败、空数据和旧请求均不补零。纯样式调整及明确固定数字快照无需取数。',
    parameters: { type: 'object', properties: { boardId: { type: 'string' }, buildId: BUILD_ID }, required: ['boardId'], additionalProperties: false }, approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: 'board_refresh' }) }] })
  })
  api.registerTool({
    name: 'toushou_boards_list',
    label: '列出看板',
    description:
      '列出投手的全部看板（名称/组件数/是否锁定）和看板数据集概况（名称/行数/列结构）。' +
      '用户问"我有哪些看板"或某个项目的数据在哪时先用它。',
    parameters: { type: 'object', properties: { buildId: BUILD_ID }, required: [] },
    approval: 'read',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: 'boards_list' }) }] })
  })

  api.registerTool({
    name: 'toushou_board_get',
    label: '查看看板',
    description: '查看一块看板的结构、updatedAt、总控与已保存的画布/模块样式。定制前先回读最新版本，保留未要求改变的数据绑定和组件。普通看板返回组件配置；读数快照看板返回有界的所选账户摘要和证据引用，包含账户名称及 ID。' +
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
        buildId: BUILD_ID,
        boardId: { type: 'string', description: '看板 ID（与 name 二选一）' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' }
      },
      required: []
    },
    approval: 'read',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_get', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_check',
    label: '检查生成看板',
    description: '生成期间按应用冻结的原始用户要求检查草稿，工具参数不能降低冻结要求；最终须board_build_commit。也可只读检查已保存看板的实际完成度，返回status、missing和issues，不修改看板或填补数据。所有生成并保存的看板都须在交付前执行检查；未执行不得声称验收通过。无具体方向的商业看板完成后用mode="default"检查可刷新数据、趋势、漏斗、分析和三方对应，日报再传daily:true检查表格。用户明确用途、风格、结构、参考或后续定制时用mode="custom"（默认），仅在required指定本次用户明确要求的能力；不要按默认清单补回用户删除或不需要的模块。用户明确固定数字或快照时用custom，优先counter，传required:[]；data在这里专指可刷新来源，不代表任意数字。若快照误传required:["data"]导致missing:data，应纠正本次验收要求后重查，不把预期未通过当作交付结论。' +
      '用户明确账户/活动/广告组/广告/素材粒度时必须传granularity；可接受广告或素材时传["ad","creative"]（OR），不能因为数据源只有活动级就改传campaign或省略约束。dimensions传返回结构中本次必须一起展示的精确列名（AND），例如实际ID列与花费、转化列；检查真实表格可见列或图表分组及当前有效ID，不以标题或隐藏字段充数。没有所需粒度时明确未完成/blocked，不擅自交付活动级替代板并称已完成。' +
      '检查实际组件和数据绑定，不以标题、占位点、手填数字、静态note或HTML文字冒充能力。只有passed:true且status为ready才算通过；否则在同一轮修复missing/issues指向的绑定、筛选或组件，再次检查。日期问题直接复用check.window的精确start/end重拉，不重新推算“近几天”；看板名和组件标题的已知日期错位也在同一轮改正，不能留待用户再次要求。源权限、连接或无数据受阻时明确blocked和保留结果，不把检查调用本身当作已完成。检查通过也不等于完成了真实平台对账。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        boardId: { type: 'string' }, name: { type: 'string', description: '看板名称，与boardId二选一' },
        mode: { type: 'string', enum: ['default', 'custom'], default: 'custom', description: '默认custom只验当前定制意图；仅无具体方向的商业方案用default' },
        required: { type: 'array', maxItems: 6, uniqueItems: true, items: { type: 'string', enum: ['data', 'trend', 'funnel', 'analysis', 'third-party', 'table'] }, description: '本次明确要求的能力；data=来自可刷新数据源的数值。固定数字快照传[]，不要因用户提到数字就传data；不强套默认模块' },
        daily: { type: 'boolean', description: '日报要求表格；其他任务不自动加日报结构' },
        granularity: { anyOf: [{ type: 'string', enum: GRANULARITIES }, { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: GRANULARITIES } }], description: '仅用户明确指定粒度时必传；单个为必须该级，数组为可接受的OR（ad或creative）；campaign不能代替ad/creative，必须真实显示有效ID' },
        dimensions: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 }, description: '本次须一起显示的精确数据列名（AND），含所需ID和指标；以实际表格可见列/图表分组与指标验收，隐藏字段不算' }
      },
      additionalProperties: false
    },
    approval: 'read',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: 'board_check' }) }] })
  })

  api.registerTool({
    name: 'toushou_board_create',
    label: '新建看板',
    description:
      '先board_build_begin取得本次草稿；本工具只在草稿中建板。完成后board_refresh统一取数、board_build_preflight核对并board_build_commit正式保存。draft:true不代表已交付。新建本机看板并回报结果；需要确认时等待用户批准，不触碰广告平台。\n' +
      '没有具体方向时，默认使用本地前端模块（可独立拖动、缩放的指标、图表与内容模块）。用户指定用途、风格、结构、参考或后续定制时优先满足该要求，不套回默认模板，不重置已有看板。用户明确要求自定义报告或整页布局时可使用 file；普通业务数据请求不自动改成静态 HTML。\n' +
      '业务数据看板默认可刷新：保留查询条件，指标和图表绑定数据源，日期切换实际重查；只有用户明确要求固定/快照时才使用 manual 固定值。不要把一次查询结果手填成默认看板，不要用大段说明卡堆砌技术参数或防御文案；首屏只留关键指标、短来源/日期标签与2–3条业务 highlight，来源细节和失败诊断按需查看。\n' +
      '用户直接给定固定数字且未要求实时查询时，优先用counter呈现该快照，用custom验收，不强加趋势或实时来源。用户明确素材/广告等数据粒度时，先核对实际ID列、查询能力与当前行；缺少所需粒度就报告未完成，不擅自用活动级数据替代。验收granularity与dimensions沿用用户任务，不随现有数据降级。\n' +
      '仅无具体方向的广告业务看板采用兜底完成度：可刷新的关键数据、真实日期粒度趋势、当前业务定义的阶段漏斗、基于证据的简短分析、已接入三方数据及其与广告后台的指标对应；日报还必须有表格。按客户目标选择派生方案，预算、素材、获客、收入、留存与日报的重点和布局不同；这不是强制所有看板使用同一模块清单或顺序。无数据、缺权限或组件能力不足时明确未完成项，不能用占位数或静态说明假充。\n' +
      '漏斗阶段和业务名称来自当前项目的真实事件与已确认映射，不能照搬其他客户；跨源阶段读数不自动等同于同一批用户的转化率。广告后台与三方分别保留指标定义、事件映射、统计范围和币种，按已确认业务口径对应；源时区不同本身不是故障。\n' +
      '未指定平台与结构时默认创建空白看板；无具体结构要求的 TT/TikTok 可从 tiktok 开始、Meta 可从 meta 开始、FB 已保存报表可从 fb-daily-v2 开始。用户自定义结构可选 blank 并按需接入读数与数据绑定；平台不决定唯一外观。可选模板：\n' +
      Object.entries(TEMPLATE_HELP).map(([id, help]) => `- ${id}：${help}`).join('\n') +
      '\n用户指定 TikTok 广告主时，必须先通过 TikTok 连接信息查询其数字 ID，并以逗号分隔的字符串传 advertiserIds；不知道 ID 时先查明或请用户提供，不能留空代替指定范围。未指定账户时留空会读取连接页所选账户，未选择时读取授权账户。' +
      '\nMeta 模板已内置 meta-reading 和自动绑定的卡片。先用board_meta_accounts读取已授权账户，按本次任务确认账户并写入meta-reading的config.accountId；也保留模块中的账户选择。不要把其卡片改为 manual 或替换成固定快照。缺失指标不补零，时区以模块实际显示为准。不需要生成 HTML/CSV 文件。\n' +
      '\nTikTok 模板可能需要报表数据；只有用户明确要求读取时才调用 touhou_tiktok_update。要求展示账户/应用业务数据的看板已包含读取意图，按指定范围获取并绑定；只是新建空白画布时不自动查询广告账户。' +
      '\n创建或修改后回读 board_get，再用toushou_board_check核对实际保存的数据绑定、具体日期、趋势日期列、漏斗阶段来源、分析引用与日报表格。无方向方案用mode="default"；明确的定制用mode="custom"并只声明本次required，不能借验收重置为默认模板。按用户信息优先级组织紧凑连续的内容，检查无意义的整行/半屏空洞、重复读数和过多技术note并在同轮整理；布局可自由定制，不新增统一模块顺序。所有已保存生成结果都要检查，未执行不得声称验收通过；已知标题日期错误与check.window在同轮修正。查询配方和组件配置通过，不等于真实生成已验收；不能把未测项目报告为通过。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        name: { type: 'string', description: '看板名称；缺省用所选起点名称' },
        template: { type: 'string', enum: TEMPLATES, description: '无具体方向时选合适起点；显式用途、风格、结构或参考优先，可用 blank 自由组合数据模块。模板不是平台限制。' },
        description: { type: 'string', description: '可选看板说明' },
        masterScope: { ...MASTER_SCOPE, description: '本次用户要求的日期范围与媒体指标；先统一总控，再让媒体和三方查询使用具体起止日期，保存scope不等于已经重查数据' },
        style: { ...CANVAS_STYLE, description: '可选画布样式：background为六位十六进制色，grid为none/dots/lines；按用户要求配置，不影响数据刷新' },
        advertiserIds: { type: 'string', description: '指定账户时必填：数字广告主 ID 字符串，多个 ID 用逗号分隔；读数与数据卡都按这些 ID 筛选。' },
        advertiserName: { type: 'string', description: '可选显示名称；提供名称时也必须提供对应 advertiserIds，数据卡按 ID 而不是名称筛选。' },
        advertiserNames: {
          type: 'array',
          description:
            '可选显示名称数组，必须同时提供对应 advertiserIds。先从 TikTok 授权账户中核实 ID；读数与数据卡均按 ID 筛选。币种不同时金额合计卡会显示 — 并标 MIX，计数指标正常合计。'
        }
      },
      required: ['buildId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_create', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_add_widget',
    label: '看板加组件',
    description: '按用户用途、结构和风格增量添加组件，不因一次修改套回默认模板。向已有看板添加一个组件（默认自动找空位；可提供位置和样式；配置不合法会被整体拒绝）。明确固定数字用counter，config:{source:"manual",value:12}（替换为用户指定值）；不要传manual:true。活指标 counter 使用 config:{source:"dataset",datasetId:"实际ID",metric:"实际列名",op:"sum"}；chart-line/chart-bar 另传 dimension:"实际维度列名"，趋势必须绑定真实日期列，不能把分活动类别或合成点数叫时间趋势。table 使用 config:{source:"dataset",datasetId:"实际ID",columns:["实际列名"],pageSize:20}，columns可省略、最多12列，pageSize为5–100，可传sortColumn/sortDirection；日报保留真实逐日/活动明细，不拿一串指标卡代替表格。funnel 使用 config:{source:"dataset",stages:[{label:"业务阶段",datasetId:"实际ID",metric:"实际列名",op:"sum"}]}，2–12个阶段可各绑不同数据集，可按真实列filterColumn/filterValue(s)筛选；阶段来自当前客户定义，不能手填value或把跨源阶段比值自动叫用户转化率。analysis 使用 config:{source:"dataset",datasetId:"实际ID",metric:"实际列名",dimension:"实际维度列名",op:"sum"}，dimension可省略，随最新数据产生最多3条描述性highlight，不编造因果；绑定当前任务目标事件/指标，若发现数据含多个事件须先过滤目标或另拉目标事件查询，不能混合不同事件的sum当优化成效；无方向方案的分析优先用它。note仅供补充AI解释或说明，内容不会随数据重算，不把旧note当新日期分析，不自动堆成长口径便签。reading-module 专用于引用已保存快照：先 board_get 获取已保存的 reading-snapshot 或 reading-module 的 boardId 和 widgetId，再通过 source 引用；不能自己提供或伪造 snapshot。仅 reading-module 的 config 传 module，kind 为 metric、spend-chart、coverage 或 note；metric 还需 metric（spend、impressions、clicks、conversions）与从0开始的 accountIndex，spend-chart 需 chart（bar、pie、donut），note 需 text。该类型是保存时的快照，不能冒充实时活卡。用户明确要求自定义报告或整页布局时可添加 file，config:{"filePath":"report.html"}，路径相对于已授权工作区，文件类型须受支持；普通业务请求不自动替换成静态文件。layout 的 w 范围1–12、h范围1–20，x/y须一起传且位置不能重叠。成功添加读数模块或 HTML file 后，应用会自动尝试在对话显示实际预览及“打开看板”；简短回复，无需搜索源码、协议、执行 shell、写额外文件或编造围栏来展示预览。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        type: { type: 'string', enum: WIDGET_TYPES },
        title: { type: 'string', description: '可选：组件标题' },
        dateScope: DATE_SCOPE,
        config: { type: 'object', description: '组件配置；reading-module 仅提供 module，不提供 snapshot。file 必须使用 config: {"filePath":"report.html"}，filePath 是已授权工作区内的相对路径，文件类型须受支持。不要使用 path、file 或 src 代替 filePath。' },
        source: { type: 'object', properties: { boardId: { type: 'string' }, widgetId: { type: 'string' } }, required: ['boardId', 'widgetId'], description: 'reading-module 必填，现有保存的读数来源。' },
        layout: { type: 'object', properties: GRID_FIELDS, required: ['w', 'h'], additionalProperties: false, description: '可选网格尺寸与位置；x/y必须成对，省略时自动找空位，不允许重叠。' },
        style: { anyOf: [WIDGET_STYLE, { type: 'null' }], description: '模块颜色、圆角、内边距、标题对齐和阴影；null清除模块自定义样式。只接受受支持的设计token，不接受CSS。' }
      },
      required: ['type', 'buildId']
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
        buildId: BUILD_ID,
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        widgetId: { type: 'string' }
      },
      required: ['widgetId', 'buildId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_remove_widget', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_update_widget',
    label: '看板改组件',
    description: '按用户要求修改单个模块的标题、位置、样式或配置。config增量合并并整体校验；仅改外观时不要重传config，不要丢失实时数据绑定。多个模块同时换布局/样式使用toushou_board_customize原子预览/应用，避免半成品。改看板名用toushou_board_rename。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        boardId: { type: 'string' },
        name: { type: 'string', description: '看板名称（与 boardId 二选一）' },
        widgetId: { type: 'string' },
        title: { type: 'string', description: '可选：新标题' },
        dateScope: DATE_SCOPE,
        config: { type: 'object', description: '可选：要覆盖的配置字段；仅改外观时省略，保留原数据绑定' },
        layout: { ...FULL_LAYOUT, description: '可选完整网格位置与尺寸，需同时传x/y/w/h' },
        style: { anyOf: [WIDGET_STYLE, { type: 'null' }], description: '可选模块样式；null清除自定义样式' }
      },
      required: ['widgetId', 'buildId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'board_update_widget', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_board_customize',
    label: '定制看板样式与结构',
    description: '按用户明确的风格、结构或参考对现有看板做原子定制。先board_get取得updatedAt及现有组件，提交version:1、expectedUpdatedAt与要改的widgetId；默认preview:true只预览不保存，核对预览符合本次用户要求后可直接preview:false应用，无需重复询问已经授权的定制。同一版本整体校验与保存，冲突时重新回读，不以旧布局覆盖新改动。不接受任意config修改或数据绑定替换，不重建模板；仅按用户本次日期要求可传受控masterScope，同步原生读数范围，纯样式修改省略masterScope。日期保存不代表查询完成，之后按具体日期重查原媒体和三方查询，并用board_check核对实际窗口。预览不等于已应用，应用后回读核对。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        version: { type: 'integer', enum: [1] }, boardId: { type: 'string' }, name: { type: 'string', description: '看板名称，与boardId二选一' },
        expectedUpdatedAt: { type: 'integer', minimum: 0, description: '刚回读board_get的updatedAt' },
        preview: { type: 'boolean', default: true, description: '默认true仅预览；false应用本次原子修改' },
        masterScope: { ...MASTER_SCOPE, description: '仅本次要求改日期时传；纯样式定制省略，保持原日期与数据绑定' },
        style: { anyOf: [CANVAS_STYLE, { type: 'null' }], description: '可选画布样式；null清除自定义画布样式' },
        widgets: { type: 'array', maxItems: 100, items: { type: 'object', properties: { widgetId: { type: 'string' }, title: { type: 'string' }, dateScope: DATE_SCOPE, layout: FULL_LAYOUT, style: { anyOf: [WIDGET_STYLE, { type: 'null' }] } }, required: ['widgetId'], additionalProperties: false } }
      },
      required: ['version', 'expectedUpdatedAt', 'buildId'], additionalProperties: false
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: 'board_customize' }) }] })
  })

  api.registerTool({
    name: 'toushou_board_rename',
    label: '看板改名',
    description: '重命名一块看板（不能与其他看板重名）。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        boardId: { type: 'string' },
        name: { type: 'string', description: '当前看板名称（与 boardId 二选一）' },
        newName: { type: 'string' }
      },
      required: ['newName', 'buildId']
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
        buildId: BUILD_ID,
        filePath: { type: 'string', description: '当前会话已授权工作区内的 CSV/XLSX 路径' },
        name: { type: 'string', description: '目标数据集名称；传「TikTok 报表」为替换式导入' }
      },
      required: ['filePath']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'dataset_import', ...params }) }] })
  })
  api.registerTool({
    name: 'toushou_af_dataset_pull',
    label: '拉取 AppsFlyer 数据集',
    description:
      '拉取 AppsFlyer 官方归因数据写入「AF-{name}」数据集，并保留完整查询条件。卡片绑定返回的 dataset.id，日期切换和刷新按看板实际范围重查。默认建活卡，仅用户明确要求固定快照时才手填数值。\n' +
      '支持多维：groupings 可含 Geo / Event name / Campaign ID / Media source / Date（最多 4 个）；metrics 可用 Count / Unique users / Installs / Active users / Revenue 等官方指标；basis 支持 activity（活动日期）或 ltv（生命周期）。\n' +
      '用法要求：\n' +
      '1. name 起短且能区分应用/范围的名字（如 产品A注册）；数据集叫 AF-{name}，卡片标题用用户熟悉的简短业务名。\n' +
      '2. 无具体方向的媒体×AF 业务看板包含媒体基础读数与 AF 活数据；按当前实际媒体选择读数来源，不因使用 AF 就强制 TikTok。显式用途、风格、结构、参考和后续定制优先，模板仅为起点；已有板增量添加所需数据，保留未要求修改的内容。\n' +
      '3. 仅沿用当前客户、项目已确认的 appId 和事件映射。用户使用业务名称时，先发现实际事件，按当前映射、名称和业务含义选择唯一最匹配的候选，再将准确 eventName 保存；自定义事件不限 af_ 前缀。只有同样合理的候选不止一个时才简短询问，不要求用户提供字段。禁止从其他客户复制事件名、阶段命名或漏斗定义。Install/App Active/Session 是内置事件，安装量可直接用 Installs 指标。\n' +
      '4. 首次拉取用 startDate/endDate 与看板总控具体日期对齐，后续沿用此查询条件重查；days 备用默认近7个完整日（截至昨天）。geo=true 仅增加 Geo 维度；countries 过滤地区，全部地区应省略过滤，绝不传 Geo=["all"]。最多4个维度。\n' +
      '5. 新业务方案显式传 mediaSources，使用当前App真实发现并已确认的媒体名称；[]为该App全部授权来源，省略仅兼容旧TikTok调用。不要根据媒体品牌猜接口别名，非TikTok方案不得省略后错标来源。\n' +
      '6. 返回的 dataset.columns 是可绑定的列名。事件次数等可加指标可用 op="sum"；独立用户用完整日期范围的专用总量查询，不把多日或多分组去重数相加。首屏只保留关键数字/highlight，不创建大段口径、防御词或原始查询参数说明卡。',
    parameters: {
      type: 'object',
      properties: {
        buildId: BUILD_ID,
        name: { type: 'string', description: '短名（1-60 字符），包含必要的应用/范围以避免重名；数据集叫 AF-{name}' },
        appId: { type: 'string', description: 'AppsFlyer App ID' },
        eventName: { type: 'string', description: '发现并匹配后的准确自定义事件名，不限前缀；业务词由助手匹配，不要求用户报字段' },
        days: { type: 'integer', description: '未指定日期时拉最近 N 个完整日（1-366，默认7，截至昨天）' },
        startDate: { type: 'string', description: 'YYYY-MM-DD，与 endDate 一起传，按看板总控的实际日期首次拉取' },
        endDate: { type: 'string', description: 'YYYY-MM-DD，与 startDate 一起传，最长366天' },
        basis: { type: 'string', enum: ['activity', 'ltv'], description: 'activity=活动日期口径（默认），ltv=生命周期口径' },
        metrics: { type: 'array', description: '官方指标名数组，默认 ["Count","Unique users"]；可用 Installs / Active users / Revenue 等', items: { type: 'string' } },
        groupings: { type: 'array', description: '维度数组（最多4个），默认按事件类型选；可用 Geo / Event name / Campaign ID / Campaign / Media source / Date', items: { type: 'string' } },
        geo: { type: 'boolean', description: 'true 时附加 Geo 维度（总维度最多4），不代表地区过滤' },
        countries: { type: 'array', items: { type: 'string' }, description: '可选地区筛选；全部地区时省略，不传字面值 all' },
        mediaSources: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 200 }, description: '当前App真实媒体名称；[]为全部授权来源，省略仅兼容旧TikTok调用；新业务方案显式传入并保留到刷新配方' }
      },
      required: ['name', 'appId']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'af_dataset_pull', ...params }) }] })
  })
}
