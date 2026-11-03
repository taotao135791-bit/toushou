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
  const basis = params.basis ?? 'activity'
  const rowCount = params.rowCount ?? 100
  if (Object.keys(params).some(k => !['appId', 'startDate', 'endDate', 'eventName', 'basis', 'rowCount'].includes(k)) || !validText(appId) || !validDate(startDate) || !validDate(endDate) || startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 365 * 86_400_000 || (eventName !== undefined && !validText(eventName)) || (basis !== 'activity' && basis !== 'ltv') || !Number.isInteger(rowCount) || Number(rowCount) < 1 || Number(rowCount) > 300) return null
  return { query: {
    start_date: startDate, end_date: endDate, app_ids: [appId], row_count: rowCount,
    metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: basis }, { metric_name: 'Unique users', attribution_source: 'appsflyer', period: basis }],
    sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }],
    groupings: eventName ? ['Campaign ID', 'Campaign', 'Media source', 'Date'] : ['Event name', 'Media source', 'Date', 'Campaign ID'],
    filters: { 'Media source': ['tiktokglobal_int'] }, in_app_event: eventName ? [eventName] : []
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
    await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'toushou-appsflyer-toolkit', version: '0.1.0' } })
    await send('notifications/initialized', {}, true)
    const result = await send('tools/call', { name, arguments: args })
    if (result.isError) throw new Error('query-failed')
    const structured = object(result.structuredContent)
    if (!structured || !Object.prototype.hasOwnProperty.call(structured, 'data')) throw new Error('invalid-data')
    return JSON.stringify({ ok: true, source: 'AppsFlyer', data: structured.data, note: '日期与时区以结果元数据为准；达到行数上限可能不完整。' })
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
    description: '只读查询一个已授权应用的 TikTok 渠道聚合数据。先用应用列表确认 appId；省略 eventName 可发现事件。日期、时区与计量口径以结果为准；行数达到上限时不要当作完整结果。',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, startDate: { type: 'string', description: 'YYYY-MM-DD' }, endDate: { type: 'string', description: 'YYYY-MM-DD' }, eventName: { type: 'string', description: '可选；省略以发现事件' }, basis: { type: 'string', enum: ['activity', 'ltv'], description: '默认 activity' }, rowCount: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['appId', 'startDate', 'endDate'], additionalProperties: false },
    execute: async (_id, params, signal) => { const args = queryArguments(params); return { content: [{ type: 'text', text: args ? await invoke('analytics_fetch_aggregated_data', args, signal) : JSON.stringify({ ok: false, error: '查询参数无效，请检查应用、日期和行数。' }) }] } }
  })
}
