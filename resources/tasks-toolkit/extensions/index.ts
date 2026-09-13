/**
 * Toushou scheduled-task tools. This package only calls the Main-owned
 * loopback bridge; the settings store and other sessions' workspaces are
 * never reachable from the OMP tool process, and a created task always runs
 * in the calling session's own project directory.
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

const bridge = process.env.TOUSHOU_TASKS

async function call(params: Record<string, unknown>): Promise<string> {
  if (!bridge) return JSON.stringify({ ok: false, error: '定时任务工具只在投手桌面端内可用' })
  try {
    const response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    })
    return JSON.stringify(await response.json()).slice(0, 24_000)
  } catch {
    return JSON.stringify({ ok: false, error: '定时任务工具暂时不可用' })
  }
}

const SCHEDULE_DOC =
  "排程 schedule 的四种写法：每天 {type:'daily',time:'09:30'}；每周 {type:'weekly',dayOfWeek:1,time:'09:00'}（0=周日..6=周六）；" +
  "仅工作日 {type:'weekdays',time:'09:00'}（周一到周五）；固定间隔 {type:'interval',hours:2} 或 {type:'interval',minutes:30}。"

const SCHEDULE_JSON = {
  type: 'object',
  description: '排程。daily/weekly/weekdays 需要 time（HH:mm），weekly 另需 dayOfWeek（0=周日），interval 需要 hours 或 minutes 之一',
  properties: {
    type: { type: 'string', description: 'daily | weekly | weekdays | interval' },
    time: { type: 'string', description: 'HH:mm，如 09:30' },
    dayOfWeek: { type: 'number', description: '0=周日 .. 6=周六（仅 weekly）' },
    hours: { type: 'number', description: '间隔小时数（interval 用）' },
    minutes: { type: 'number', description: '间隔分钟数（interval 用，与 hours 二选一）' }
  },
  required: ['type']
} as const

export default function taskTools(api: ToolHostApi): void {
  api.registerTool({
    name: 'toushou_task_list',
    label: '查看定时任务',
    description: '列出用户的所有定时任务（名称、排程、启用状态、上次运行）。',
    parameters: { type: 'object', properties: {}, required: [] },
    approval: 'read',
    execute: async (_id, _params) => ({ content: [{ type: 'text', text: await call({ action: 'task_list' }) }] })
  })
  api.registerTool({
    name: 'toushou_task_create',
    label: '创建定时任务',
    description:
      '创建一个定时任务：到点自动在当前项目目录里用这条提示词启动一次分析。' +
      `任务运行目录固定为当前项目，无需也不能指定其他目录。${SCHEDULE_DOC} ` +
      '可选 notifyChannel："feishu" 表示每轮完成后把结果摘要推送到飞书（默认只发系统通知）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，简短可读' },
        prompt: { type: 'string', description: '每次执行时投手收到的完整提示词' },
        schedule: SCHEDULE_JSON,
        notifyOnComplete: { type: 'boolean', description: '完成后是否通知，默认 true' },
        notifyChannel: { type: 'string', description: '通知渠道：system（默认）或 feishu（需已连接飞书）' },
        permissionMode: { type: 'string', description: 'default（跟随全局）或 readonly（只读执行）' }
      },
      required: ['name', 'prompt', 'schedule']
    },
    approval: 'write',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await call({ action: 'task_create', ...(params ?? {}) }) }] })
  })
  api.registerTool({
    name: 'toushou_task_delete',
    label: '删除定时任务',
    description: '按 id 删除一个定时任务。id 来自 toushou_task_list。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 id' } },
      required: ['taskId']
    },
    approval: 'write',
    execute: async (_id, params) => ({
      content: [{ type: 'text', text: await call({ action: 'task_delete', taskId: params?.taskId }) }]
    })
  })
}
