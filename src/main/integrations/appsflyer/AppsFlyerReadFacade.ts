import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AppsFlyerConnectionManager } from './AppsFlyerConnectionManager'
import { AppsFlyerMcpClient } from './AppsFlyerMcpClient'

type Obj = Record<string, unknown>
const object = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
function readBody(req: IncomingMessage): Promise<unknown> { return new Promise((resolve, reject) => { let n = 0; let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { n += Buffer.byteLength(chunk); if (n > 64_000) { reject(new Error('too large')); req.destroy(); return }; body += chunk }); req.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('invalid json')) } }); req.on('error', reject) }) }
/** Private loopback MCP capability: no remote access token leaves Main. */
export class AppsFlyerReadFacade {
  private server?: Server
  private readonly token = randomBytes(32).toString('base64url')
  private readonly sessions = new Map<string, number>()
  constructor(private readonly manager: AppsFlyerConnectionManager, private readonly now: () => number = Date.now) {}
  async initialize(): Promise<{ endpoint: string; token: string }> {
    if (this.server) throw new Error('already-started')
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('listener-failed')); return }; resolve(address.port) }) })
    return { endpoint: `http://127.0.0.1:${port}/mcp`, token: this.token }
  }
  close(): void { this.sessions.clear(); this.server?.close(); this.server = undefined }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!['POST', 'DELETE'].includes(req.method ?? '') || req.url !== '/mcp' || !same(req.headers.authorization ?? '', `Bearer ${this.token}`)) { res.writeHead(403); res.end(); return }
    if (req.method === 'DELETE') {
      const session = req.headers['mcp-session-id']
      if (typeof session !== 'string' || !this.sessions.delete(session)) { res.writeHead(400); res.end(); return }
      res.writeHead(204); res.end(); return
    }
    const reply = (status: number, value?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    let p: Obj | null
    try { p = object(await readBody(req)) } catch { reply(400); return }
    if (!p || p.jsonrpc !== '2.0' || typeof p.method !== 'string' || (p.id !== undefined && typeof p.id !== 'string' && typeof p.id !== 'number')) { reply(400); return }
    const id = p.id
    const result = (value: unknown, headers?: Record<string, string>) => reply(200, { jsonrpc: '2.0', id, result: value }, headers)
    const fail = (message: string) => reply(200, { jsonrpc: '2.0', id, error: { code: -32602, message } })
    if (p.method === 'initialize') {
      const now = this.now()
      for (const [session, lastUsed] of this.sessions) if (now - lastUsed >= 3_600_000) this.sessions.delete(session)
      if (id === undefined || this.sessions.size >= 100) { reply(400); return }
      const session = randomBytes(24).toString('base64url'); this.sessions.set(session, now)
      result({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'toushou-appsflyer-readonly', version: '1.0.0' } }, { 'mcp-session-id': session }); return
    }
    const session = req.headers['mcp-session-id']
    if (typeof session !== 'string' || !this.sessions.has(session)) { reply(400); return }
    this.sessions.set(session, this.now())
    if (p.method === 'notifications/initialized' && id === undefined) { reply(202); return }
    if (id === undefined) { reply(400); return }
    if (p.method === 'ping') { result({}); return }
    if (p.method === 'tools/list') {
      try {
        const cached = await this.manager.getVerifiedToolDescriptions()
        if (!cached) throw new Error('not connected')
        const tools = cached.map(tool => ({ name: tool.name, description: `${typeof tool.description === 'string' ? tool.description : ''}\n只读；仅允许单个 App、最多 366 天、300 行、最多一个事件（空事件用于发现）。返回达到行数上限时不能视为完整。`, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true } }))
        result({ tools }); return
      } catch { fail('AppsFlyer connection unavailable'); return }
    }
    if (p.method !== 'tools/call') { fail('Unsupported method'); return }
    const params = object(p.params); const args = params?.name === 'get_apps' && params.arguments === undefined ? {} : object(params?.arguments)
    if (!params || !args || typeof params.name !== 'string') { fail('Invalid request'); return }
    let token: string | undefined
    try {
      if (params.name === 'get_apps' && Object.keys(args).length !== 0) throw new Error('invalid query')
      if (!['get_apps', 'analytics_fetch_aggregated_data'].includes(params.name)) throw new Error('unsupported tool')
      const credentials = await this.manager.loadFreshCredentials()
      if (!credentials) throw new Error('not connected')
      token = credentials.accessToken
      const client = new AppsFlyerMcpClient(credentials.accessToken); await client.initialize()
      const data = params.name === 'get_apps' ? await client.listApps() : await client.queryRaw(args)
      const text = typeof data === 'string' ? `${data}\n\n注意：返回行数达到请求上限时，结果可能不完整。` : JSON.stringify(data)
      result({ content: [{ type: 'text', text }], structuredContent: { data } })
    } catch (error) { this.manager.markReadFailure(error, token); result({ isError: true, content: [{ type: 'text', text: 'AppsFlyer 只读查询失败；请检查连接、应用权限和查询范围。' }] }) }
  }
}
