/**
 * Toushou TikTok tools. This package only calls the Main-owned loopback
 * bridge; tokens and the dataset store are never reachable from the OMP
 * tool process. The report lands in the shared "TikTok 报表" dataset the
 * boards bind to — 定时任务会话与普通会话走同一工具，因此“每天自动更新
 * TikTok 看板”的定时任务天然成立。
 */
interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: unknown
  approval?: 'read' | 'write' | 'exec'
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

interface ToolHostApi {
  registerTool(tool: ToolDefinition): void
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
  const update: ToolDefinition = {
    name: 'toushou_tiktok_update',
    label: '更新 TikTok 看板',
    description:
      '拉取 TikTok Ads 近 7 天分活动报表（消耗/展示/点击/点击率/转化/转化成本），写入 "TikTok 报表" 看板数据集。' +
      '与看板读数共用 TikTok 官方授权；此操作还会更新本地数据集，因此受当前会话写入权限和确认约束。' +
      'permission-denied 表示本地写入未获允许，按返回 reason/hint 解释，不能称为 TikTok 未连接或要求重新授权。',
    parameters: {
      type: 'object',
      properties: {
        advertiserId: { type: 'string', description: '可选：指定已授权广告主 ID，必须是数字字符串；省略则读取已配置的广告主，未配置时读取授权广告主。' }
      },
      required: []
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ ...params, action: 'tiktok_update' }) }] })
  }
  const status: ToolDefinition = {
    name: 'toushou_tiktok_status',
    label: 'TikTok 连接状态',
    description: '查看 TikTok 授权配置、报表刷新结果及当前会话的本地数据集写入权限；配置状态和写入权限分别判断，失败须按 reason/hint 说明，不能臆测存在两套独立授权。',
    parameters: { type: 'object', properties: {}, required: [] },
    approval: 'read',
    execute: async (_id, _params) => ({ content: [{ type: 'text', text: await call({ action: 'tiktok_status' }) }] })
  }
  api.registerTool(update)
  api.registerTool(status)
  // Persisted conversations can replay the original misspelled names.
  // Keep only compact aliases rather than duplicating their full guidance.
  api.registerTool({ ...update, name: 'touhou_tiktok_update', description: '旧会话兼容别名；新调用使用 toushou_tiktok_update。' })
  api.registerTool({ ...status, name: 'touhou_tiktok_status', description: '旧会话兼容别名；新调用使用 toushou_tiktok_status。' })
}
