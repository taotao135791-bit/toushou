/**
 * toushou-browser-use — tools that drive the 投手 in-app browser panel.
 *
 * The GUI starts a loopback-only HTTP bridge and hands its address (with the
 * session token in the path) to the runtime via the TOUSHOU_BROWSER_USE env
 * var — the same delivery pattern as the approval extension's config. Every
 * tool call maps to one whitelisted bridge action; the GUI executes it on
 * the panel's WebContents and returns JSON. This module never runs page
 * scripts itself, and the bridge never accepts script source either.
 *
 * Reading strategy (see skills/browser-use/SKILL.md): DOM snapshot first,
 * screenshot only when text cannot answer the question.
 */

interface BridgeResult {
  ok: boolean
  error?: string
  url?: string
  title?: string
  text?: string
  elements?: Array<{
    ref: number
    tag: string
    type?: string
    text?: string
    value?: string
  }>
  imagePath?: string
}

const BRIDGE = process.env.TOUSHOU_BROWSER_USE

async function call(body: Record<string, unknown>): Promise<string> {
  let result: BridgeResult
  if (!BRIDGE) {
    result = {
      ok: false,
      error: 'browser-use bridge unavailable: these tools only work inside the 投手 desktop app'
    }
  } else {
    try {
      const res = await fetch(BRIDGE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      result = (await res.json()) as BridgeResult
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return JSON.stringify(result).slice(0, 24_000)
}

interface ToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  approval?: 'read' | 'write' | 'exec'
  execute: (params: Record<string, unknown>) => Promise<string>
}

interface ToolHostApi {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    approval?: 'read' | 'write' | 'exec'
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown
    ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }): void
}

function tool(def: ToolDef): Parameters<ToolHostApi['registerTool']>[0] {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    approval: def.approval,
    execute: async (_toolCallId, params) => ({
      content: [{ type: 'text', text: await def.execute(params ?? {}) }]
    })
  }
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : ''
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export default function browserUseTools(api: ToolHostApi): void {
  api.registerTool(
    tool({
      name: 'browser_navigate',
      label: 'Browser Navigate',
      description:
        '在投手内置浏览器中打开一个 http(s) 网址并等待加载。返回最终 URL 和页面标题。这是浏览器操作的第一步。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      approval: 'read',
      execute: (p) => call({ action: 'navigate', url: str(p, 'url') })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_snapshot',
      label: 'Browser Snapshot',
      description:
        '读取当前页面的源码快照（优先使用这个，不要急着截图）：返回页面正文文本和可交互元素列表，每个元素带 ref 编号，供 browser_click / browser_type 使用。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'snapshot' })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_click',
      label: 'Browser Click',
      description:
        '用真实鼠标事件点击快照中某个 ref 编号的元素（链接/按钮等）。点击后返回新页面的 URL 与标题。',
      parameters: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] },
      approval: 'write',
      execute: (p) => call({ action: 'click', ref: num(p, 'ref', 0) })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_type',
      label: 'Browser Type',
      description:
        '向某个 ref 编号的输入框输入文本（会先聚焦并选中已有内容），可选 submit=true 在输入后按回车提交。用于搜索框、表单字段。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number' },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['ref', 'text']
      },
      approval: 'write',
      execute: (p) =>
        call({ action: 'type', ref: num(p, 'ref', 0), text: str(p, 'text'), submit: p.submit === true })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_scroll',
      label: 'Browser Scroll',
      description:
        '滚动当前页面（direction: up 或 down，amount 为像素，默认 600）。滚动后内容变化需要重新 snapshot。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number' }
        },
        required: ['direction']
      },
      approval: 'read',
      execute: (p) =>
        call({
          action: 'scroll',
          direction: str(p, 'direction') === 'up' ? 'up' : 'down',
          amount: num(p, 'amount', 600)
        })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_screenshot',
      label: 'Browser Screenshot',
      description:
        '截取当前页面的渲染截图，保存为 PNG 并返回文件路径。仅在源码快照无法回答时使用（如判断视觉版面、验证渲染结果）。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'screenshot' })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_back',
      label: 'Browser Back',
      description: '浏览器后退一步。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'back' })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_forward',
      label: 'Browser Forward',
      description: '浏览器前进一步。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'forward' })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_wait',
      label: 'Browser Wait',
      description: '等待指定毫秒（最多 5000）让页面完成动态加载，然后返回当前 URL。',
      parameters: { type: 'object', properties: { ms: { type: 'number' } } },
      approval: 'read',
      execute: (p) => call({ action: 'wait', ms: num(p, 'ms', 1000) })
    })
  )
}
