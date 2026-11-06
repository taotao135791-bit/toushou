import { describe, expect, it } from 'vitest'
import registerBoardsTools from '../../../resources/boards-toolkit/extensions/index'
import { APPSFLYER_SKILL } from '../integrations/appsflyer/appsflyerSkill'

describe('board toolkit prompt contract', () => {
  it('uses a fallback only without direction and preserves explicit customization', () => {
    const registered: Array<{ name: string; description: string }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const create = registered.find(tool => tool.name === 'toushou_board_create')!
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    expect(create.description).toContain('默认创建空白看板')
    expect(create.description).toContain('没有具体方向时')
    expect(create.description).toContain('用户指定用途、风格、结构、参考或后续定制时优先')
    expect(create.description).toContain('不重置已有看板')
    expect(create.description).not.toContain('必须选 tiktok')
    expect(create.description).toContain('平台不决定唯一外观')
    expect(create.description).toContain('meta-reading 和自动绑定的卡片')
    expect(create.description).toContain('缺失指标不补零')
    expect(add.description).toContain('用户明确要求自定义报告或整页布局时可添加 file')
    expect(create.description).toContain('只有用户明确要求读取时')
    expect(create.description).not.toContain('立即调用 touhou_tiktok_update')
    expect(add.description).toContain('已保存的 reading-snapshot 或 reading-module')
    expect(add.description).toContain('自动尝试在对话显示实际预览')
    expect(add.description).toContain('无需搜索源码、协议、执行 shell')
    expect(add.description).toContain('仅 reading-module 的 config 传 module')
    expect(add.description).toContain('不能冒充实时活卡')
    expect(add.description).toContain('{"filePath":"report.html"}')
  })
  it('provides the exact file widget path contract to the model', () => {
    const registered: Array<{ name: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    const params = add.parameters as { properties: { config: { description: string } } }
    const hint = params.properties.config.description
    expect(hint).toContain('{"filePath":"report.html"}')
    expect(hint).toContain('已授权工作区内的相对路径')
    expect(hint).toContain('不要使用 path、file 或 src')
  })
  it('defaults business boards to live data and resolves business event labels before saving a recipe', () => {
    const registered: Array<{ name: string; description: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    expect(registered.find(tool => tool.name === 'toushou_board_create')!.description).toContain('只有用户明确要求固定/快照时才使用 manual')
    const pull = registered.find(tool => tool.name === 'toushou_af_dataset_pull')!
    expect(pull.description).toContain('唯一最匹配的候选')
    expect(pull.description).toContain('自定义事件不限 af_ 前缀')
    expect(pull.description).toContain('不要求用户提供字段')
    expect(pull.description).toContain('绑定返回的 dataset.id')
    expect(pull.description).toContain('不把多日或多分组去重数相加')
    expect(pull.parameters).toMatchObject({ properties: { startDate: { type: 'string' }, endDate: { type: 'string' }, countries: { type: 'array' }, mediaSources: { type: 'array', maxItems: 32 } } })
    expect(pull.description).toContain('不因使用 AF 就强制 TikTok')
    expect(pull.description).toContain('禁止从其他客户复制事件名')
  })
  it('covers a complete fallback without turning custom tasks into a fixed template', () => {
    const registered: Array<{ name: string; description: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const create = registered.find(tool => tool.name === 'toushou_board_create')!
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    for (const requirement of ['可刷新的关键数据', '真实日期粒度趋势', '阶段漏斗', '简短分析', '三方数据', '日报还必须有表格', '回读 board_get']) expect(create.description).toContain(requirement)
    expect(create.description).toContain('不是强制所有看板使用同一模块清单或顺序')
    expect(add.parameters).toMatchObject({ properties: { type: { enum: expect.arrayContaining(['counter', 'chart-line', 'table', 'funnel', 'analysis', 'file']) } } })
    expect(add.description).toContain('趋势必须绑定真实日期列')
    expect(add.description).toContain('阶段来自当前客户定义')
    expect(APPSFLYER_SKILL).toContain('不同客户的事件名称、阶段和漏斗定义不得相互复制')
    expect(APPSFLYER_SKILL).toContain('只有用户没有具体方向时')
    expect(add.description).toContain('随最新数据产生最多3条描述性highlight')
    expect(add.description).toContain('不把旧note当新日期分析')
  })
  it('checks explicit custom requirements without silently imposing default coverage', () => {
    const registered: Array<{ name: string; description: string; parameters: unknown; approval?: string }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const check = registered.find(tool => tool.name === 'toushou_board_check')!
    expect(check.approval).toBe('read')
    expect(check.parameters).toMatchObject({ properties: { mode: { enum: ['default', 'custom'], default: 'custom' }, required: { uniqueItems: true, items: { enum: ['data', 'trend', 'funnel', 'analysis', 'third-party', 'table'] } }, daily: { type: 'boolean' } } })
    expect(check.description).toContain('不要按默认清单补回用户删除或不需要的模块')
    expect(check.description).toContain('不以标题、占位点、手填数字、静态note或HTML文字冒充能力')
    expect(check.parameters).toMatchObject({ properties: {
      granularity: { anyOf: [{ type: 'string', enum: ['account', 'campaign', 'adgroup', 'ad', 'creative'] }, { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: ['account', 'campaign', 'adgroup', 'ad', 'creative'] } }] },
      dimensions: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true }
    } })
    expect(check.description).toContain('不能因为数据源只有活动级就改传campaign或省略约束')
    expect(check.description).toContain('没有所需粒度时明确未完成/blocked')
    expect(check.description).toContain('所有生成并保存的看板都须在交付前执行检查')
    expect(check.description).toContain('未执行不得声称验收通过')
    expect(check.description).toContain('日期错位也在同一轮改正')
    const create = registered.find(tool => tool.name === 'toushou_board_create')!
    expect(create.description).toContain('优先用counter呈现该快照')
    expect(create.description).toContain('无意义的整行/半屏空洞')
    expect(create.description).toContain('不新增统一模块顺序')
  })
  it('exposes atomic presentation edits separately from data configuration', () => {
    const registered: Array<{ name: string; description: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const customize = registered.find(tool => tool.name === 'toushou_board_customize')!
    const params = customize.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(params.required).toEqual(['version', 'expectedUpdatedAt', 'buildId'])
    expect(params.properties).toMatchObject({ preview: { default: true }, style: { anyOf: expect.any(Array) }, widgets: { maxItems: 100, items: { properties: { layout: { required: ['x', 'y', 'w', 'h'] } }, additionalProperties: false } } })
    expect(params.properties).not.toHaveProperty('config')
    expect(customize.description).toContain('不接受任意config修改或数据绑定替换')
    expect(params.properties).toMatchObject({ masterScope: { required: ['range', 'metrics'], properties: { range: { enum: ['yesterday', 'today', 'last3', 'last7', 'last30'] } } } })
    expect(customize.description).toContain('日期保存不代表查询完成')
    expect(customize.description).toContain('预览不等于已应用')
  })

  it('requires a current draft reference for board writes and exposes host-owned commit and refresh', () => {
    const registered: Array<{ name: string; description: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    for (const name of ['create', 'add_widget', 'update_widget', 'remove_widget', 'rename', 'customize']) {
      const tool = registered.find(item => item.name === `toushou_board_${name}`)!
      expect(tool.parameters).toMatchObject({ properties: { buildId: { type: 'string' } }, required: expect.arrayContaining(['buildId']) })
    }
    const begin = registered.find(item => item.name === 'toushou_board_build_begin')!
    expect(begin.parameters).toMatchObject({ additionalProperties: false, properties: { targetBoardId: { type: 'string' } } })
    expect(begin.parameters).not.toHaveProperty('properties.required')
    const commit = registered.find(item => item.name === 'toushou_board_build_commit')!
    expect(commit.parameters).toMatchObject({ required: ['buildId'], additionalProperties: false })
    expect(commit.description).toContain('published:true')
    const refresh = registered.find(item => item.name === 'toushou_board_refresh')!
    expect(refresh.parameters).toMatchObject({ properties: { boardId: { type: 'string' } }, required: ['boardId'], additionalProperties: false })
    expect(refresh.parameters).not.toHaveProperty('properties.startDate')
    const add = registered.find(item => item.name === 'toushou_board_add_widget')!
    expect(add.parameters).toMatchObject({ properties: { dateScope: { anyOf: expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({ mode: { const: 'lookback' }, anchor: { const: 'reportEnd' } }) })]) } } })
  })
})
