import Papa from 'papaparse'
import { proxyFetchFor } from '../tiktok/proxyFetch'
import { APPSFLYER_MCP_ENDPOINT } from './constants'
import type { MmpEventAggregate } from '../../../shared/mmpEvents'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
const TOOLS = ['get_apps', 'analytics_fetch_aggregated_data'] as const
export type AppsFlyerTool = typeof TOOLS[number]
export type AppsFlyerEventQuery = { appId: string; eventName: string; startDate: string; endDate: string }
export type AppsFlyerApp = { appId: string; name: string; platform: string | null }
const fetchProxy: Fetcher = async (url, init) => (await proxyFetchFor(url, 'appsflyer'))(url, init)
const validText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x)
const date = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
export function validateEventQuery(q: AppsFlyerEventQuery): void {
  if (!validText(q.appId, 200) || !validText(q.eventName, 200) || !date(q.startDate) || !date(q.endDate) || q.startDate > q.endDate || Date.parse(q.endDate) - Date.parse(q.startDate) > 365 * 86_400_000) throw new Error('invalid-query')
}
export function eventQueryArguments(q: AppsFlyerEventQuery): Obj {
  validateEventQuery(q)
  // Built-in events (App Active, Install, Session, …) reject BOTH an
  // in_app_event filter AND the Count metric grouped by campaign — the proven
  // shape for them is the discovery query (group by Event name, no filter).
  // Custom in-app events follow the af_ prefix convention and need the exact
  // event filter.
  const isBuiltIn = !q.eventName.toLowerCase().startsWith('af_')
  return { query: { start_date: q.startDate, end_date: q.endDate, app_ids: [q.appId], row_count: 100, metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: 'activity' }, { metric_name: 'Unique users', attribution_source: 'appsflyer', period: 'activity' }], sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }], groupings: isBuiltIn ? ['Event name', 'Media source', 'Date', 'Campaign ID'] : ['Campaign ID', 'Campaign', 'Media source', 'Date'], filters: { 'Media source': ['tiktokglobal_int'] }, in_app_event: isBuiltIn ? [] : [q.eventName] } }
}

/** A single authenticated MCP session, restricted to the two known read-only tools. */
export class AppsFlyerMcpClient {
  private session?: string
  private version = '2025-03-26'
  private nextId = 0
  private tools = new Map<string, Obj>()
  constructor(private readonly accessToken: string, private readonly fetcher: Fetcher = fetchProxy, private readonly signal?: AbortSignal) {}
  private async send(method: string, params: Obj, notification = false): Promise<Obj> {
    const id = ++this.nextId
    const headers: Record<string, string> = { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.version
    const timeout = AbortSignal.timeout(30_000)
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
    let r: Response
    try { r = await this.fetcher(APPSFLYER_MCP_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal, redirect: 'error' }) } catch { throw new Error('appsflyer-network-error') }
    if (!r.ok) {
      // The message stays exactly 'appsflyer-authorization-error' / '…-request-error'
      // (callers match on it); status + a bounded body snippet ride as properties.
      const base = r.status === 401 || r.status === 403 ? 'appsflyer-authorization-error' : 'appsflyer-request-error'
      const detail = await r.text().then((t) => t.slice(0, 200)).catch(() => '')
      const error = new Error(base) as Error & { statusCode?: number; detail?: string }
      error.statusCode = r.status
      error.detail = detail
      throw error
    }
    this.session = r.headers.get('mcp-session-id') ?? this.session
    if (notification) return {}
    const text = await r.text()
    if (text.length > 5_000_000) throw new Error('appsflyer-response-too-large')
    let payload: unknown
    try { payload = r.headers.get('content-type')?.includes('text/event-stream') ? text.split(/\r?\n\r?\n/).map(e => e.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean).map(x => JSON.parse(x)).find(x => x.id === id) : JSON.parse(text) } catch { throw new Error('appsflyer-invalid-response') }
    const p = obj(payload)
    if (!p || p.jsonrpc !== '2.0' || p.id !== id || p.error || !obj(p.result)) throw new Error('appsflyer-invalid-response')
    return obj(p.result)!
  }
  async initialize(): Promise<void> {
    const result = await this.send('initialize', { protocolVersion: this.version, capabilities: {}, clientInfo: { name: 'toushou-appsflyer-readings', version: '1.0.0' } })
    if (typeof result.protocolVersion !== 'string' || !result.protocolVersion) throw new Error('appsflyer-protocol-error')
    this.version = result.protocolVersion; await this.send('notifications/initialized', {}, true)
    let cursor: string | undefined; const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const p = await this.send('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(p.tools)) throw new Error('appsflyer-invalid-tools')
      for (const v of p.tools) { const t = obj(v); if (t && typeof t.name === 'string' && TOOLS.includes(t.name as AppsFlyerTool)) this.tools.set(t.name, t) }
      if (!p.nextCursor) return
      if (typeof p.nextCursor !== 'string' || seen.has(p.nextCursor)) throw new Error('appsflyer-invalid-tools')
      cursor = p.nextCursor; seen.add(cursor)
    }
    throw new Error('appsflyer-tool-limit')
  }
  toolDescriptions(): Obj[] { return TOOLS.flatMap(name => { const tool = this.tools.get(name); return tool ? [tool] : [] }) }
  private async call(name: AppsFlyerTool, args: Obj): Promise<string> {
    if (!TOOLS.includes(name) || !this.tools.has(name)) throw new Error('appsflyer-tool-unavailable')
    const result = await this.send('tools/call', { name, arguments: args })
    if (result.isError) throw new Error('appsflyer-tool-error')
    const structured = obj(result.structuredContent)
    // The official tools/call answer carries the payload in structuredContent.data
    // (same field the bundled toolkit reads); some relays use .result — try it
    // second, then the text content.
    let value: unknown = structured?.data ?? structured?.result
    if (typeof value !== 'string' && Array.isArray(result.content)) value = result.content.map(obj).find(x => x?.type === 'text' && typeof x.text === 'string')?.text
    if (typeof value !== 'string' || value.length > 5_000_000) throw new Error('appsflyer-invalid-data')
    return value
  }
  async listApps(): Promise<AppsFlyerApp[]> { return parseApps(await this.call('get_apps', {})) }
  async queryEvents(q: AppsFlyerEventQuery): Promise<MmpEventAggregate[]> {
    const text = await this.call('analytics_fetch_aggregated_data', eventQueryArguments(q))
    try {
      return parseEvents(text, q)
    } catch (error) {
      // Surface the raw shape so a provider format change is diagnosable
      // from the pull result alone.
      const e = error as Error & { raw?: string }
      e.raw = text.slice(0, 600)
      throw e
    }
  }
  async queryRaw(input: unknown): Promise<string> {
    const args = obj(input); const rawQuery = obj(args?.query)
    if (!args || Object.keys(args).length !== 1 || !rawQuery) throw new Error('invalid-query')
    const query: Obj = { ...rawQuery, row_count: rawQuery.row_count ?? 25, groupings: rawQuery.groupings ?? [], in_app_event: rawQuery.in_app_event ?? [], filters: rawQuery.filters ?? {} }
    const allowed = new Set(['start_date', 'end_date', 'app_ids', 'row_count', 'metrics', 'groupings', 'filters', 'sort_by_metrics', 'in_app_event'])
    if (Object.keys(query).some(key => !allowed.has(key)) || !Array.isArray(query.app_ids) || query.app_ids.length !== 1 || !Array.isArray(query.in_app_event) || query.in_app_event.length > 1 || query.in_app_event.some(x => !validText(x, 200))) throw new Error('invalid-query')
    const appId = query.app_ids[0]; const startDate = query.start_date; const endDate = query.end_date
    if (typeof appId !== 'string' || typeof startDate !== 'string' || typeof endDate !== 'string') throw new Error('invalid-query')
    validateEventQuery({ appId, eventName: typeof query.in_app_event[0] === 'string' ? query.in_app_event[0] : 'event-discovery', startDate, endDate })
    if (!Number.isInteger(query.row_count) || Number(query.row_count) < 1 || Number(query.row_count) > 300 || !Array.isArray(query.metrics) || query.metrics.length < 1 || query.metrics.length > 10 || !Array.isArray(query.groupings) || query.groupings.length > 4 || query.groupings.some(x => !validText(x, 100)) || !obj(query.filters)) throw new Error('invalid-query')
    if (JSON.stringify(args).length > 12_000) throw new Error('invalid-query')
    const metricNames = query.metrics.map(metric => obj(metric)?.metric_name)
    if (metricNames.some(name => !validText(name, 100))) throw new Error('invalid-query')
    let sort = query.sort_by_metrics
    if (sort == null) sort = [{ metric_name: metricNames.includes('Count') ? 'Count' : metricNames[0], order: 'desc' }]
    if (!Array.isArray(sort) || sort.length < 1 || sort.length > 10 || sort.some(entry => { const x = obj(entry); return !x || !metricNames.includes(x.metric_name) || (x.order !== 'asc' && x.order !== 'desc') || Object.keys(x).some(key => key !== 'metric_name' && key !== 'order') })) throw new Error('invalid-query')
    return this.call('analytics_fetch_aggregated_data', { query: { ...query, sort_by_metrics: sort } })
  }
}

export function parseApps(text: string): AppsFlyerApp[] {
  if (/^\s*(?:📱\s*)?no apps found in your account\s*$/i.test(text) || /^\s*(?:📱\s*)?found\s+0\s+app(?:\(s\)|s)?\s+in your account\s*$/i.test(text)) return []
  const count = /found\s+(\d+)\s+app/i.exec(text)
  if (!count || Number(count[1]) > 1000) throw new Error('appsflyer-invalid-apps')
  const lines = text.split(/\r?\n/); const apps: AppsFlyerApp[] = []
  let name: string | undefined; let appId: string | undefined; let platform: string | null = null
  const push = () => { if (name && appId) apps.push({ name, appId, platform }); name = undefined; appId = undefined; platform = null }
  for (const line of lines) { const title = /^\s*\d+\.\s+(.+?)\s*$/.exec(line); if (title) { push(); name = title[1]; continue }; const id = /^\s*App ID:\s*(.*?)\s*$/i.exec(line); if (id) appId = id[1]; const p = /^\s*Platform:\s*(.*?)\s*$/i.exec(line); if (p) platform = p[1] || null }
  push()
  if (apps.length !== Number(count[1]) || apps.some(a => !validText(a.name, 300) || !validText(a.appId, 200))) throw new Error('appsflyer-incomplete-apps')
  return apps
}
function value(row: Record<string, string>, pattern: RegExp): string | undefined { const keys = Object.keys(row).filter(k => pattern.test(k)); if (keys.length > 1) throw new Error('appsflyer-ambiguous-column'); return keys.length ? row[keys[0]] : undefined }
function number(s: string | undefined): number | null { if (s === undefined || s.trim() === '' || s.trim() === '-') return null; const n = Number(s); if (!Number.isFinite(n) || n < 0) throw new Error('appsflyer-invalid-number'); return n }
export function parseEvents(text: string, q: AppsFlyerEventQuery): MmpEventAggregate[] {
  validateEventQuery(q)
  // The no-data-in-window answer is `## Data: ; ## Metadata: {…}` on ONE line —
  // an empty selection, not a parse failure (empty ≠ zero; the caller shows nothing).
  if (/^\s*## Data:\s*;\s*## Metadata:/m.test(text)) {
    const empty: MmpEventAggregate[] & { raw?: string } = []
    empty.raw = text.slice(0, 800)
    return empty
  }
  const section = /^\s*## Data:\s*([^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*(?:;[ \t]*)?## Metadata:[ \t]*([^\r\n]*)/m.exec(text)
  if (!section) throw new Error('appsflyer-invalid-data')
  let metadata: Obj | null
  try { metadata = obj(JSON.parse(section[3])) } catch { throw new Error('appsflyer-invalid-metadata') }
  if (!metadata) throw new Error('appsflyer-invalid-metadata')
  const csv = Papa.parse<Record<string, string>>(`${section[1]}\n${section[2]}`, { header: true, skipEmptyLines: true, dynamicTyping: false })
  if (csv.errors.length || csv.data.length >= 300) throw new Error('appsflyer-incomplete-data')
  const metricEntries = (pattern: RegExp) => Object.entries(metadata).filter(([k]) => pattern.test(k)).map(([, v]) => obj(v))
  const countMeta = metricEntries(/^count(?:_|\s).*activity/i)
  const usersMeta = metricEntries(/^unique(?:_|\s)+users(?:_|\s).*activity/i)
  if (countMeta.length > 1 || usersMeta.length > 1) throw new Error('appsflyer-ambiguous-metadata')
  for (const entry of [...countMeta, ...usersMeta]) {
    const eventFilter = obj(entry?.filters)?.['event-name']
    if (eventFilter !== undefined && (!Array.isArray(eventFilter) || eventFilter.length !== 1 || eventFilter[0] !== q.eventName)) throw new Error('appsflyer-scope-mismatch')
  }
  const partialFlags = [countMeta[0]?.['partial-data?'], usersMeta[0]?.['partial-data?']]
  const partial = partialFlags.includes(true) ? true : partialFlags.every(flag => flag === false) ? false : null
  const timezone = typeof metadata.timezone === 'string' && validText(metadata.timezone, 100) ? metadata.timezone : null
  const currency = typeof metadata.currency === 'string' && /^[A-Z]{3}$/.test(metadata.currency) ? metadata.currency : null
  return csv.data.map(row => {
    const media = value(row, /^media source$/i); const campaignId = value(row, /^campaign id$/i)?.trim() || null; const day = value(row, /^date$/i)?.trim() || null
    // Discovery-shaped answers carry the event per row; named queries take the spec.
    const eventName = value(row, /^event name$/i)?.trim() || q.eventName
    if (media && media.toLowerCase() !== 'tiktokglobal_int') throw new Error('appsflyer-scope-mismatch')
    if (day && (!date(day) || day < q.startDate || day > q.endDate)) throw new Error('appsflyer-scope-mismatch')
    return { source: 'appsflyer', appId: q.appId, mediaSource: media ? 'tiktok' : null, campaignId, day, timezone, dateBasis: 'activity', metricBasis: 'activity', eventName, count: number(value(row, /^count(?:\s|_).*activity/i)), uniqueUsers: number(value(row, /^unique users(?:\s|_).*activity/i)), revenue: null, currency, partial, updatedAt: null }
  })
}
