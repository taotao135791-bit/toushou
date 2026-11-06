/** AppsFlyer read-only tools use a Main-owned local capability, never an official token. */
interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: unknown
  approval: 'read'
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}
interface ToolHostApi { registerTool(tool: ToolDefinition): void }
type Obj = Record<string, unknown>
const object = (value: unknown): Obj | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null
const validText = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

function localCapability(): { url: string; token: string } | null {
  try {
    const value = object(JSON.parse(process.env.TOUSHOU_APPSFLYER ?? ''))
    if (!value || typeof value.url !== 'string' || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) return null
    const url = new URL(value.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) return null
    return { url: url.toString(), token: value.token }
  } catch { return null }
}

export function queryArguments(params: Obj): Obj | null {
  const { appId, startDate, endDate } = params
  const eventName = params.eventName === undefined || params.eventName === '' ? undefined : params.eventName
  const isBuiltIn = typeof eventName === 'string' && ['app active', 'install', 'session'].includes(eventName.toLowerCase())
  const isCustom = !!eventName && !isBuiltIn
  const basis = params.basis ?? 'activity'
  const rowCount = params.rowCount ?? 100
  const mediaSources = params.mediaSources === undefined ? ['tiktokglobal_int'] : params.mediaSources
  if (Object.keys(params).some(k => !['appId', 'startDate', 'endDate', 'eventName', 'basis', 'rowCount', 'mediaSources'].includes(k)) || !validText(appId) || !validDate(startDate) || !validDate(endDate) || startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 365 * 86_400_000 || (eventName !== undefined && !validText(eventName)) || (basis !== 'activity' && basis !== 'ltv') || !Number.isInteger(rowCount) || Number(rowCount) < 1 || Number(rowCount) > 300 || !Array.isArray(mediaSources) || mediaSources.length > 32 || mediaSources.some(source => !validText(source) || String(source).toLowerCase() === 'all')) return null
  return { query: {
    start_date: startDate, end_date: endDate, app_ids: [appId], row_count: rowCount,
    metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: basis }, { metric_name: 'Unique users', attribution_source: 'appsflyer', period: basis }],
    sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }],
    groupings: isCustom ? ['Campaign ID', 'Campaign', 'Media source', 'Date'] : ['Event name', 'Media source', 'Date', 'Campaign ID'],
    filters: mediaSources.length ? { 'Media source': [...new Set(mediaSources)] } : {}, in_app_event: isCustom ? [eventName] : []
  } }
}

async function invoke(name: 'get_apps' | 'analytics_fetch_aggregated_data', args: Obj, signal?: AbortSignal): Promise<string> {
  const capability = localCapability()
  if (!capability) return JSON.stringify({ ok: false, error: 'AppsFlyer 工具未就绪，请在连接页检查连接。' })
  let session: string | null = null
  let id = 0
  try {
    const send = async (method: string, params: Obj, notification = false): Promise<Obj> => {
      const requestId = ++id
      const headers: Record<string, string> = { authorization: `Bearer ${capability.token}`, 'content-type': 'application/json', accept: 'application/json' }
      if (session) headers['mcp-session-id'] = session
      const timeout = AbortSignal.timeout(35_000)
      const response = await fetch(capability.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
      if (!response.ok) throw new Error('unavailable')
      if (method === 'initialize') {
        session = response.headers.get('mcp-session-id')
        if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('invalid-session')
      }
      if (notification) return {}
      const text = await response.text()
      if (text.length > 5_000_000) throw new Error('oversize')
      const payload = object(JSON.parse(text))
      if (!payload || payload.jsonrpc !== '2.0' || payload.id !== requestId || payload.error || !object(payload.result)) throw new Error('invalid-response')
      return object(payload.result)!
    }
    await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'toushou-appsflyer-toolkit', version: '0.2.0' } })
    await send('notifications/initialized', {}, true)
    const result = await send('tools/call', { name, arguments: args })
    if (result.isError) throw new Error('query-failed')
    const structured = object(result.structuredContent)
    if (!structured || !Object.prototype.hasOwnProperty.call(structured, 'data')) throw new Error('invalid-data')
    if (name === 'analytics_fetch_aggregated_data' && typeof structured.data === 'string' && !/^\s*## Data:/m.test(structured.data)) throw new Error('query-failed')
    return JSON.stringify({ ok: true, source: 'AppsFlyer', data: structured.data })
  } catch {
    return JSON.stringify({ ok: false, error: 'AppsFlyer 只读查询未完成，请检查连接、应用权限和查询范围后重试。' })
  } finally {
    if (session) {
      try { await fetch(capability.url, { method: 'DELETE', headers: { authorization: `Bearer ${capability.token}`, 'mcp-session-id': session }, signal: AbortSignal.timeout(2_000), redirect: 'error' }) } catch { /* best effort session cleanup */ }
    }
  }
}

export default function appsFlyerTools(api: ToolHostApi): void {
  api.registerTool({ name: 'toushou_appsflyer_apps', label: '查看 AppsFlyer 应用', approval: 'read', description: '只读列出当前授权的 AppsFlyer 应用。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: async (_id, params, signal) => ({ content: [{ type: 'text', text: Object.keys(params).length ? JSON.stringify({ ok: false, error: '此查询不需要参数。' }) : await invoke('get_apps', {}, signal) }] }) })
  api.registerTool({
    name: 'toushou_appsflyer_query', label: '查询 AppsFlyer 归因', approval: 'read',
    description: '只读查询一个已授权应用的聚合数据。仅沿用当前客户和项目已确认的 appId，或先查应用列表。业务方案应显式传 mediaSources：使用当前App真实发现的媒体名称；[]表示查询该App全部授权来源，可用于发现候选；省略仅为旧调用兼容TikTok，非TikTok方案不得省略后错标来源。用户使用业务名称时，先省略 eventName 发现真实事件，结合当前项目映射和业务含义选择唯一最匹配候选，再传准确 eventName（自定义事件不限 af_ 前缀）；只有多个候选同样合理时才简短询问，不要求用户提供技术字段。不从其他客户复用事件名称或阶段定义，不按媒体品牌猜接口别名。结果按用户任务给关键数字和基于证据的分析，来源细节按需展开；达到行数上限不能当全量。',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, startDate: { type: 'string', description: 'YYYY-MM-DD' }, endDate: { type: 'string', description: 'YYYY-MM-DD' }, eventName: { type: 'string', description: '可选；省略先发现候选，再传最匹配的实际事件名称，不限制命名前缀' }, mediaSources: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 200 }, description: '当前App真实媒体名称；[]为该App全部授权来源，省略仅兼容旧TikTok调用；新业务方案显式传入' }, basis: { type: 'string', enum: ['activity', 'ltv'], description: '默认 activity' }, rowCount: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['appId', 'startDate', 'endDate'], additionalProperties: false },
    execute: async (_id, params, signal) => { const args = queryArguments(params); return { content: [{ type: 'text', text: args ? await invoke('analytics_fetch_aggregated_data', args, signal) : JSON.stringify({ ok: false, error: '查询参数无效，请检查应用、日期和行数。' }) }] } }
  })
}
