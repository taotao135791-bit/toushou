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
  reading?: unknown
  verified?: boolean
  readings?: unknown[]
  elements?: Array<{
    ref: number
    tag: string
    type?: string
    text?: string
    value?: string
  }>
  imagePath?: string
  truncated?: boolean
  snapshotId?: string
  tabId?: number
  observedAt?: number
}

const BRIDGE = process.env.TOUSHOU_BROWSER_USE

function serializeResult(result: BridgeResult): string {
  const projected: BridgeResult = {
    ...result,
    ...(typeof result.text === 'string' && result.text.length > 12_000
      ? { text: `${result.text.slice(0, 11_999)}…`, truncated: true }
      : {}),
    ...(result.elements ? { elements: result.elements.slice(0, 80) } : {}),
    ...(result.readings
      ? {
          readings: result.readings.slice(0, 8).map((reading) => {
            if (!reading || typeof reading !== 'object') return reading
            const value = reading as Record<string, unknown>
            return {
              ...value,
              ...(Array.isArray(value.rows)
                ? { rows: value.rows.slice(0, 24), ...(value.rows.length > 24 ? { truncated: true } : {}) }
                : {})
            }
          })
        }
      : {})
  }
  let text = JSON.stringify(projected)
  if (new TextEncoder().encode(text).byteLength <= 24_000) return text
  const fallback: Record<string, unknown> = {
    ok: projected.ok,
    truncated: true,
    truncation: { reason: 'transport-byte-limit' }
  }
  if (projected.error) fallback.error = projected.error
  if (projected.url) fallback.url = projected.url
  if (projected.title) fallback.title = projected.title
  text = JSON.stringify(fallback)
  return new TextEncoder().encode(text).byteLength <= 24_000
    ? text
    : JSON.stringify({ ok: false, truncated: true, error: 'result-too-large' })
}

async function call(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  let result: BridgeResult
  if (!BRIDGE) {
    result = {
      ok: false,
      error: 'browser-use bridge unavailable: these tools only work inside the 投手 desktop app'
    }
  } else {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      const onAbort = () => controller.abort()
      if (signal?.aborted) controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const res = await fetch(BRIDGE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      try {
        result = (await res.json()) as BridgeResult
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return serializeResult(result)
}

interface ToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  approval?: 'read' | 'write' | 'exec'
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<string>
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
    execute: async (_toolCallId, params, signal) => ({
      content: [{ type: 'text', text: await def.execute(params ?? {}, signal) }]
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
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          takeover: { type: 'boolean', description: '面板被其他会话占用时传 true 接管（仅 navigate 支持）' }
        },
        required: ['url']
      },
      approval: 'read',
      execute: (p) =>
        call({
          action: 'navigate',
          url: str(p, 'url'),
          ...(p.takeover === true ? { takeover: true } : {})
        })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_snapshot',
      label: 'Browser Snapshot',
      description:
        '读取当前页面的源码快照（优先使用这个，不要急着截图）：返回页面正文文本、可交互元素列表，以及 snapshotId/tabId/observedAt。每个元素带 ref；click/type 必须使用同一快照的 snapshotId，页面变化后先重新 snapshot。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'snapshot' })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_report',
      label: 'Browser Report',
      description:
        '读取当前 FB Ads Manager 广告系列页并返回硬核验证过的结构化读数（JSON，verified=true）：账户、日期范围、每个广告系列的消耗/单次成效/CPM/成效/点击/CTR/CPC/安装量、汇总总消耗。数字由本地严格解析器提取，且必须通过四道锁才会返回：行数=页面汇总标记数、行求和=汇总总消耗、双读结构一致、页面稳定。任何一道不过即拒报（incomplete-view / totals-mismatch / unstable-page / unparseable-page）——无数据好过错数据，自动化可安全消费。给用户转述时如实报告错误原因，不要自行估算补数。',
      parameters: { type: 'object', properties: {} },
      approval: 'read',
      execute: () => call({ action: 'report' })
    })
  )

  api.registerTool(
    tool({
      name: 'fb_history',
      label: 'FB Reading History',
      description:
        '查询本地 FB 读数历史（只含四道锁验证过的读数，无未验证数字）：每次 browser_report 成功后自动累积。返回按时间排序的样本（capturedAt/账户/时间范围/总消耗/各系列消耗），适合画趋势、对比今天 vs 昨天、生成看板卡片提议。参数：accountId 可选过滤，limit 默认 10（最大 50）。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          limit: { type: 'number' }
        }
      },
      approval: 'read',
      execute: (p) =>
        call({
          action: 'history',
          ...(str(p, 'accountId') ? { accountId: str(p, 'accountId') } : {}),
          limit: num(p, 'limit', 10)
        })
    })
  )

  api.registerTool(
    tool({
      name: 'browser_click',
      label: 'Browser Click',
      description:
        '用真实鼠标事件点击快照中某个 ref 编号的元素（链接/按钮等）。点击后返回新页面的 URL 与标题。',
      parameters: { type: 'object', properties: { ref: { type: 'number' }, snapshotId: { type: 'string' } }, required: ['ref', 'snapshotId'] },
      approval: 'write',
      execute: (p) => call({ action: 'click', ref: num(p, 'ref', 0), snapshotId: str(p, 'snapshotId') })
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
          snapshotId: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['ref', 'text', 'snapshotId']
      },
      approval: 'write',
      execute: (p) =>
        call({ action: 'type', ref: num(p, 'ref', 0), text: str(p, 'text'), submit: p.submit === true, snapshotId: str(p, 'snapshotId') })
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
