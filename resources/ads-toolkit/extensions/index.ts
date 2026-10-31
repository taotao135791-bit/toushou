/**
 * Toushou ads-copy generation tools. The model pool (user-configured
 * providers with their own API keys) is owned by Main over the loopback
 * bridge — keys never reach the OMP tool process, and the chat session's own
 * model is never involved: copy generation runs on the pool the user
 * configured in 投手's Connections page.
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

const bridge = process.env.TOUSHOU_COPY

async function call(params: Record<string, unknown>): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '文案生成工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    })
    return JSON.stringify(await response.json()).slice(0, 40_000)
  } catch {
    return JSON.stringify({ ok: false, error: '文案生成工具暂时不可用' })
  }
}

export default function adsCopyTools(api: ToolHostApi): void {
  api.registerTool({
    name: 'toushou_copy_generate',
    label: '文案模型生成',
    description:
      '用文案模型池里的模型生成文本（与当前对话所用模型完全独立）。写广告文案/素材时使用：把完整的生成指令（含产品事实、规格约束、语言市场）作为 prompt 传入，system 传角色设定。\n' +
      '用法：默认全池并发生成（一次拿多个模型的稿子再统一评分）；传 model 指定某个供应商只跑它；传 agentId（建议用产品名）则同一产品每次稳定分配同一模型。\n' +
      '返回 mode-is-chat 时说明用户设置了「跟随对话模型」：不要重试本工具，直接按 ads-copy 技能用当前对话模型生成。池为空时提醒用户去投手「连接」页的文案模型池添加模型。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整生成指令（含产品事实与规格约束）' },
        system: { type: 'string', description: '可选：角色/风格设定' },
        model: { type: 'string', description: '可选：指定池内供应商名' },
        agentId: { type: 'string', description: '可选：稳定分配键（建议产品名），同一键每次拿到同一模型' }
      },
      required: ['prompt']
    },
    approval: 'exec',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'copy_generate', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_copy_generate_batch',
    label: '文案批量生成（引擎）',
    description:
      '广告文案专用：产品事实 + 数量 → 模型池自动跑完整评分引擎（五维打分、字节/合规硬校验、不达标自动重试换模型、Top-N 优选去重），返回已评分已筛选的成品与诊断（哪条多少分、重试了几轮、哪个模型挂了）。\n' +
      'product：{ language（必填，如 en/zh-CN/es/fr/de）, market?, device?, benefits[]（只允许写这些卖点）, brandTerms[]?, tone? }；categories：[{type:"short"|"long", qty:1-50}]；可选 targets（各维达标线 0-10）、maxAttempts(1-5,默认3)、model（指定供应商）、agentId（产品名，稳定分配模型）。\n' +
      '交付时把返回 items 按技能表格呈现（含分数与字节），不要改写文案本身。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'object', description: '产品事实（语言/市场/卖点/品牌词/语气）' },
        categories: { type: 'array', description: '品类与数量，如 [{"type":"short","qty":5},{"type":"long","qty":5}]' },
        targets: { type: 'object', description: '可选达标线 {hook,relevance,cta,space,total} 0-10' },
        maxAttempts: { type: 'number' },
        model: { type: 'string' },
        agentId: { type: 'string' }
      },
      required: ['product']
    },
    approval: 'exec',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'copy_generate_batch', ...params }) }] })
  })

  api.registerTool({
    name: 'toushou_copy_models_list',
    label: '查看文案模型池',
    description: '列出文案模型池的供应商与当前池成员（只读，不含密钥）。',
    parameters: { type: 'object', properties: {}, required: [] },
    approval: 'read',
    execute: async () => ({ content: [{ type: 'text', text: await call({ action: 'copy_models_list' }) }] })
  })
}
