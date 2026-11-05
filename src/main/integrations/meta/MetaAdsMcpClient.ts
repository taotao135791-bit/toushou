import { proxyFetchFor } from '../tiktok/proxyFetch'
import { META_ADS_MCP_ENDPOINT, META_ADS_TOOLS } from './constants'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type Obj = Record<string, unknown>
type MetaAdsTool = typeof META_ADS_TOOLS[number]
const obj = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
const fetchProxy: Fetcher = async (url, init) => (await proxyFetchFor(url, 'meta-ads'))(url, init)

/** A single authenticated MCP session, restricted to the two known read-only tools. */
export class MetaAdsMcpClient {
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
    try { r = await this.fetcher(META_ADS_MCP_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal, redirect: 'error' }) } catch { throw new Error('meta-ads-network-error') }
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'meta-ads-authorization-error' : 'meta-ads-request-error')
    this.session = r.headers.get('mcp-session-id') ?? this.session
    if (notification) return {}
    const text = await r.text()
    if (text.length > 5_000_000) throw new Error('meta-ads-response-too-large')
    let payload: unknown
    try { payload = r.headers.get('content-type')?.includes('text/event-stream') ? text.split(/\r?\n\r?\n/).map(e => e.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean).map(x => JSON.parse(x)).find(x => x.id === id) : JSON.parse(text) } catch { throw new Error('meta-ads-invalid-response') }
    const p = obj(payload)
    if (!p || p.jsonrpc !== '2.0' || p.id !== id || p.error || !obj(p.result)) throw new Error('meta-ads-invalid-response')
    return obj(p.result)!
  }
  async initialize(): Promise<void> {
    const result = await this.send('initialize', { protocolVersion: this.version, capabilities: {}, clientInfo: { name: 'toushou-meta-ads-readings', version: '1.0.0' } })
    if (typeof result.protocolVersion !== 'string' || !result.protocolVersion) throw new Error('meta-ads-protocol-error')
    this.version = result.protocolVersion; await this.send('notifications/initialized', {}, true)
    let cursor: string | undefined; const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const p = await this.send('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(p.tools)) throw new Error('meta-ads-invalid-tools')
      for (const v of p.tools) { const t = obj(v); if (t && typeof t.name === 'string' && META_ADS_TOOLS.includes(t.name as MetaAdsTool)) { if (this.tools.has(t.name)) throw new Error('meta-ads-invalid-tools'); this.tools.set(t.name, t) } }
      if (!p.nextCursor) return
      if (typeof p.nextCursor !== 'string' || seen.has(p.nextCursor)) throw new Error('meta-ads-invalid-tools')
      cursor = p.nextCursor; seen.add(cursor)
    }
    throw new Error('meta-ads-tool-limit')
  }
  toolDescriptions(): Obj[] { return META_ADS_TOOLS.flatMap(name => { const tool = this.tools.get(name); return tool ? [tool] : [] }) }
  async callReadTool(name: string, args: Obj): Promise<Obj> {
    if (!META_ADS_TOOLS.includes(name as MetaAdsTool) || !this.tools.has(name) || !obj(args) || JSON.stringify(args).length > 32_000) throw new Error('meta-ads-invalid-query')
    const result = await this.send('tools/call', { name, arguments: args })
    // Never echo an upstream grant, even if a provider returns it in an error.
    const serialized = JSON.stringify(result)
    if (serialized.includes(this.accessToken)) throw new Error('meta-ads-invalid-data')
    return result
  }
}
