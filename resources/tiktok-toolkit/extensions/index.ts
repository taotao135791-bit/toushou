/**
 * Toushou TikTok tools. This package only calls the Main-owned loopback
 * bridge; tokens and the dataset store are never reachable from the OMP
 * tool process. The report lands in the shared "TikTok 报表" dataset the
 * boards bind to — 定时任务会话与普通会话走同一工具，因此“每天自动更新
 * TikTok 看板”的定时任务天然成立。
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

const bridge = process.env.TOUSHOU_TIKTOK

async function call(params: Record<string, unknown>): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: 'TikTok 工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    })
    return JSON.stringify(await response.json()).slice(0, 24_000)
  } catch {
    return JSON.stringify({ ok: false, error: 'TikTok 工具暂时不可用' })
  }
}

export default function tiktokTools(api: ToolHostApi): void {
  api.registerTool({
    name: 'touhou_tiktok_update',
    label: '更新 TikTok 看板',
    description:
      '拉取 TikTok Ads 近 7 天分活动报表（消耗/展示/点击/点击率/转化/转化成本），写入 "TikTok 报表" 看板数据集。' +
      '需要先在连接页配置 TikTok 凭据。看板图表绑定该数据集，更新后即反映最新数据。',
    parameters: {
      type: 'object',
      properties: {
        advertiserId: { type: 'number', description: '可选：指定广告主 ID（多广告主时使用）' }
      },
      required: []
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'tiktok_update', ...params }) }] })
  })
  api.registerTool({
    name: 'touhou_tiktok_status',
    label: 'TikTok 连接状态',
    description: '查看 TikTok 凭据配置状态、自动刷新开关、上次刷新时间与结果。',
    parameters: { type: 'object', properties: {}, required: [] },
    approval: 'read',
    execute: async (_id, _params) => ({ content: [{ type: 'text', text: await call({ action: 'tiktok_status' }) }] })
  })
}
