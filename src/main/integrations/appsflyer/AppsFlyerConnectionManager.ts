import { app, shell } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { TikTokCredentialStore, type TikTokStoredCredentials } from '../tiktok/TikTokCredentialStore'
import { TikTokCredentialStorageError } from '../tiktok/tiktokCredentialStorageError'
import { proxyFetchFor } from '../tiktok/proxyFetch'
import { AppsFlyerMcpClient } from './AppsFlyerMcpClient'
import { APPSFLYER_MCP_ENDPOINT } from './constants'
import type { ConnectionDefinition, ConnectionStatus } from '../../../shared/connections'

const BASE = 'https://mcp.appsflyer.com'
const DEFINITION: ConnectionDefinition = { id: 'appsflyer', kind: 'oauth', label: 'AppsFlyer', description: '连接 AppsFlyer 官方 MCP，读取已有聚合数据。', capabilities: ['mcp'] }
export interface AppsFlyerConnectionSnapshot { definition: ConnectionDefinition; status: ConnectionStatus; connected: boolean; lastError?: string; lastConnectedAt?: number; tokenExpiresAt?: number; authorizationUrl?: string }
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type Credentials = TikTokStoredCredentials
type ToolDescription = Record<string, unknown>
type Store = Pick<TikTokCredentialStore, 'load' | 'save' | 'clear' | 'retry' | 'sharedStorageBlockedEpoch'>
type Flow = { server: Server; state: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string; tokenEndpoint: string; timeout: ReturnType<typeof setTimeout>; epoch: number | null; exchanging: boolean }
const validEndpoint = (s: unknown): s is string => typeof s === 'string' && (() => { try { const u = new URL(s); return u.origin === BASE && !u.username && !u.password && !u.hash } catch { return false } })()
const proxyFetch: Fetcher = async (url, init) => (await proxyFetchFor(url, 'appsflyer'))(url, init)

/** Owns interactive OAuth; tokens never enter renderer, settings, or MCP config. */
export class AppsFlyerConnectionManager {
  private readonly store: Store
  private readonly fetcher: Fetcher
  private readonly open: (url: string) => Promise<void>
  private readonly onChange: (snapshot: AppsFlyerConnectionSnapshot) => void
  private readonly now: () => number
  private readonly probe: (token: string) => Promise<ToolDescription[]>
  private readonly filePath?: string
  private credentials: Credentials | null = null
  private status: ConnectionStatus = 'disconnected'
  private error?: string
  private connectedAt?: number
  private url?: string
  private flow: Flow | null = null
  private generation = 0
  private pendingSave: Promise<void> | null = null
  private pendingRefresh: Promise<boolean> | null = null
  private pendingDisconnect: Promise<AppsFlyerConnectionSnapshot> | null = null
  private storageBlocked = false
  private verified = false
  private verifiedToken: string | null = null
  private verifiedTools: ToolDescription[] = []
  private pendingVerification: { token: string; generation: number; promise: Promise<boolean> } | null = null
  constructor(options: { credentialStore?: Store; fetchImpl?: Fetcher; openExternal?: (url: string) => Promise<void>; onChange?: (snapshot: AppsFlyerConnectionSnapshot) => void; now?: () => number; probe?: (token: string) => Promise<ToolDescription[]> } = {}) {
    this.filePath = options.credentialStore ? undefined : path.join(app.getPath('userData'), 'appsflyer-credentials.bin')
    this.store = options.credentialStore ?? new TikTokCredentialStore({ filePath: this.filePath })
    this.fetcher = options.fetchImpl ?? proxyFetch
    this.open = options.openExternal ?? ((url) => shell.openExternal(url))
    this.onChange = options.onChange ?? (() => {})
    this.now = options.now ?? Date.now
    this.probe = options.probe ?? (async token => { const client = new AppsFlyerMcpClient(token, this.fetcher); await client.initialize(); return client.toolDescriptions() })
  }
  getSnapshot(): AppsFlyerConnectionSnapshot { return { definition: DEFINITION, status: this.status, connected: this.status === 'connected', ...(this.error ? { lastError: this.error } : {}), ...(this.connectedAt ? { lastConnectedAt: this.connectedAt } : {}), ...(this.credentials?.expiresAt ? { tokenExpiresAt: this.credentials.expiresAt } : {}), ...(this.status === 'waiting_for_user' && this.url ? { authorizationUrl: this.url } : {}) } }
  private emit(): void { this.onChange(this.getSnapshot()) }
  async initialize(): Promise<void> {
    const generation = this.generation
    try { const c = await this.store.load(); if (generation !== this.generation) return; this.credentials = c; if (!c?.accessToken) { this.status = 'disconnected'; this.emit(); return }; this.status = 'connecting'; this.emit(); const fresh = await this.loadFreshCredentials(); if (generation !== this.generation) return; if (!fresh) { this.status = 'degraded'; this.error = 'AppsFlyer 授权不可用，请重新连接'; this.emit(); return }; if (this.verifiedToken !== fresh.accessToken) await this.checkConnection(fresh.accessToken, generation) }
    catch (error) { if (generation !== this.generation) return; if (error instanceof TikTokCredentialStorageError) { this.storageBlocked = true; this.error = '安全凭据存储不可用，请在连接页重试' } else if (!this.error) this.error = 'AppsFlyer 连接暂不可用，请重试'; this.status = 'degraded'; this.emit() }
  }
  async begin(): Promise<AppsFlyerConnectionSnapshot> {
    if (this.flow || this.status === 'connecting') return this.getSnapshot()
    const generation = ++this.generation
    const epoch = this.store.sharedStorageBlockedEpoch()
    if (this.pendingDisconnect) await this.pendingDisconnect
    if (this.pendingRefresh) await this.pendingRefresh
    if (this.pendingSave) await this.pendingSave.catch(() => {})
    if (generation !== this.generation) return this.getSnapshot()
    try {
      const recoveringStorage = this.storageBlocked
      if (recoveringStorage) { this.credentials = await this.store.retry(epoch); this.storageBlocked = false }
      else if (!this.credentials) this.credentials = await this.store.load()
      if (generation !== this.generation) return this.getSnapshot()
      this.status = 'connecting'; this.error = undefined; this.emit()
      if (recoveringStorage && this.credentials?.accessToken) {
        const fresh = await this.loadFreshCredentials()
        if (generation !== this.generation) return this.getSnapshot()
        if (fresh && await this.checkConnection(fresh.accessToken, generation)) return this.getSnapshot()
        if (generation !== this.generation) return this.getSnapshot()
      }
      const meta = await this.json(`${BASE}/.well-known/oauth-authorization-server`)
      if (generation !== this.generation) return this.getSnapshot()
      if (!validEndpoint(meta.authorization_endpoint) || !validEndpoint(meta.token_endpoint) || !validEndpoint(meta.registration_endpoint)) throw new Error('invalid metadata')
      const listener = await this.listen()
      if (generation !== this.generation) { listener.server.close(); return this.getSnapshot() }
      const redirectUri = `http://127.0.0.1:${listener.port}/callback`
      let registration: Record<string, unknown>
      try { registration = await this.json(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Toushou', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }) }) }
      catch (error) { listener.server.close(); throw error }
      if (generation !== this.generation) { listener.server.close(); return this.getSnapshot() }
      if (typeof registration.client_id !== 'string' || !registration.client_id || typeof registration.client_secret !== 'string' || !registration.client_secret) { listener.server.close(); throw new Error('invalid registration') }
      const verifier = randomBytes(32).toString('base64url')
      const state = randomBytes(24).toString('base64url')
      const flow: Flow = { server: listener.server, state, verifier, redirectUri, clientId: registration.client_id, clientSecret: registration.client_secret, tokenEndpoint: meta.token_endpoint, epoch, exchanging: false, timeout: setTimeout(() => { if (this.flow === flow) this.fail('授权超时，请重试') }, 600_000) }
      this.flow = flow
      const url = new URL(meta.authorization_endpoint)
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: flow.clientId, redirect_uri: redirectUri, scope: 'user', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: APPSFLYER_MCP_ENDPOINT })) url.searchParams.set(key, value)
      this.url = url.toString(); this.status = 'waiting_for_user'; this.emit()
      try { await this.open(this.url) } catch { if (this.flow === flow) { this.error = '无法打开浏览器，请手动打开授权链接'; this.emit() } }
    } catch (error) { if (generation === this.generation) { if (error instanceof TikTokCredentialStorageError) this.storageBlocked = true; this.fail('连接初始化失败，请重试或检查安全存储') } }
    return this.getSnapshot()
  }
  cancel(): AppsFlyerConnectionSnapshot { ++this.generation; this.closeFlow(); this.status = this.storageBlocked ? 'degraded' : this.credentials?.accessToken ? (this.verified ? 'connected' : 'degraded') : 'disconnected'; this.error = this.status === 'degraded' ? 'AppsFlyer 连接尚未验证，请重试' : undefined; this.emit(); return this.getSnapshot() }
  async disconnect(): Promise<AppsFlyerConnectionSnapshot> {
    ++this.generation; this.closeFlow(); this.clearVerifiedTools()
    if (this.pendingDisconnect) return this.pendingDisconnect
    const run = (async () => {
      if (this.pendingRefresh) await this.pendingRefresh
      if (this.pendingSave) await this.pendingSave.catch(() => {})
      try {
        await this.store.clear()
        if (this.filePath) {
          try { await lstat(this.filePath); throw new Error('credential still exists') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
      } catch { this.status = 'degraded'; this.error = '无法删除本机凭据，请重试'; this.emit(); return this.getSnapshot() }
      this.credentials = null; this.verified = false; this.storageBlocked = false; this.status = 'disconnected'; this.error = undefined; this.emit(); return this.getSnapshot()
    })()
    this.pendingDisconnect = run
    try { return await run } finally { if (this.pendingDisconnect === run) this.pendingDisconnect = null }
  }
  async openAuthorizationUrl(url: string): Promise<boolean> { if (!this.url || url !== this.url || this.status !== 'waiting_for_user') return false; try { await this.open(url); return true } catch { return false } }
  markReadFailure(error: unknown, token?: string): void {
    if (!this.pendingDisconnect && this.credentials?.accessToken && (!token || this.credentials.accessToken === token) && error instanceof Error && error.message === 'appsflyer-authorization-error') { this.clearVerifiedTools(); this.status = 'degraded'; this.error = 'AppsFlyer 授权已失效或权限不足，请重新连接'; this.emit() }
  }
  hasVerifiedTools(): boolean { return !this.pendingDisconnect && this.status === 'connected' && !!this.credentials?.accessToken && this.verifiedToken === this.credentials.accessToken && this.verifiedTools.length === 2 }
  async getVerifiedToolDescriptions(): Promise<ToolDescription[] | null> {
    const credentials = await this.loadFreshCredentials()
    if (!credentials || !this.hasVerifiedTools() || this.verifiedToken !== credentials.accessToken) return null
    return structuredClone(this.verifiedTools)
  }
  async loadFreshCredentials(): Promise<{ accessToken: string } | null> {
    if (this.pendingDisconnect) return null
    if (this.storageBlocked) throw new Error('安全凭据存储不可用')
    const generation = this.generation
    if (!this.credentials) { try { const c = await this.store.load(); if (generation !== this.generation) return null; this.credentials = c } catch { this.storageBlocked = true; this.status = 'degraded'; this.error = '安全凭据存储不可用，请在连接页重试'; this.emit(); throw new Error('安全凭据存储不可用') } }
    const c = this.credentials
    if (!c?.accessToken) return null
    if (c.expiresAt && c.expiresAt <= this.now() + 60_000) {
      if (!this.pendingRefresh) { const p = this.refresh(c, generation); this.pendingRefresh = p; void p.finally(() => { if (this.pendingRefresh === p) this.pendingRefresh = null }) }
      if (!(await this.pendingRefresh)) throw new Error('连接已过期，请重新授权')
      if (generation !== this.generation || this.pendingDisconnect || !this.credentials?.accessToken) return null
      if (this.verifiedToken !== this.credentials.accessToken && !(await this.checkConnection(this.credentials.accessToken, generation))) throw new Error('AppsFlyer 只读工具不可用')
    }
    if (generation !== this.generation || this.pendingDisconnect || !this.credentials?.accessToken) return null
    return { accessToken: this.credentials.accessToken }
  }
  private async refresh(c: Credentials, generation: number): Promise<boolean> {
    if (!c.refreshToken || !validEndpoint(c.tokenEndpoint)) { this.clearVerifiedTools(); this.status = 'degraded'; this.error = '连接已过期，请重新授权'; this.emit(); return false }
    try {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret ?? '' })
      const tokens = await this.token(c.tokenEndpoint, body)
      if (generation !== this.generation) return false
      const next = { ...c, ...tokens, refreshToken: tokens.refreshToken ?? c.refreshToken }
      const saving = this.store.save(next, { beforeCommit: () => generation === this.generation })
      this.pendingSave = saving; try { await saving } finally { if (this.pendingSave === saving) this.pendingSave = null }
      if (generation !== this.generation) return false
      this.credentials = next; this.clearVerifiedTools(); return true
    } catch (error) { if (generation === this.generation) { this.clearVerifiedTools(); if (error instanceof TikTokCredentialStorageError) this.storageBlocked = true; this.status = 'degraded'; this.error = this.storageBlocked ? '安全凭据存储不可用，请在连接页重试' : '连接续期失败，请重新授权'; this.emit() }; return false }
  }
  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> { if (!validEndpoint(url)) throw new Error('invalid endpoint'); const r = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' }); if (!r.ok) throw new Error('request failed'); const x = await r.json(); if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('invalid response'); return x as Record<string, unknown> }
  private async token(url: string, body: URLSearchParams): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }> { const x = await this.json(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }); if (typeof x.access_token !== 'string' || !x.access_token) throw new Error('invalid token'); return { accessToken: x.access_token, ...(typeof x.refresh_token === 'string' && x.refresh_token ? { refreshToken: x.refresh_token } : {}), ...(typeof x.expires_in === 'number' && Number.isFinite(x.expires_in) && x.expires_in > 0 ? { expiresAt: this.now() + x.expires_in * 1000 } : {}), ...(typeof x.scope === 'string' ? { scope: x.scope } : {}) } }
  private listen(): Promise<{ server: Server; port: number }> { return new Promise((resolve, reject) => { const server = createServer((req, res) => this.callback(req, res)); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const addr = server.address(); if (!addr || typeof addr === 'string') { server.close(); reject(new Error('listener failed')); return }; resolve({ server, port: addr.port }) }) }) }
  private callback(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') { res.writeHead(u.pathname === '/favicon.ico' ? 204 : 404); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const f = this.flow
    const state = u.searchParams.get('state'); const a = Buffer.from(state ?? ''); const b = Buffer.from(f?.state ?? '')
    if (!f || u.searchParams.getAll('state').length !== 1 || !state || a.length !== b.length || !timingSafeEqual(a, b)) { res.writeHead(400); res.end('Authorization callback mismatch.'); return }
    if (f.exchanging) { res.writeHead(202); res.end('Authorization is processing.'); return }
    const codes = u.searchParams.getAll('code')
    if (u.searchParams.has('error') || codes.length !== 1 || !codes[0]) { res.writeHead(400); res.end('Authorization failed.'); this.fail('授权未完成，请重试'); return }
    f.exchanging = true; res.writeHead(200, { 'cache-control': 'no-store' }); res.end('Authorization received. Return to Toushou.'); void this.exchange(f, codes[0])
  }
  private async exchange(f: Flow, code: string): Promise<void> {
    const generation = this.generation
    const current = () => this.generation === generation && this.flow === f
    try {
      const tokens = await this.token(f.tokenEndpoint, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: f.redirectUri, client_id: f.clientId, client_secret: f.clientSecret, code_verifier: f.verifier }))
      if (!current()) return
      const next = { clientId: f.clientId, clientSecret: f.clientSecret, tokenEndpoint: f.tokenEndpoint, ...tokens, savedAt: this.now() }
      let committed = false
      const saving = this.store.save(next, { retryNewAuthorizationEpoch: f.epoch, beforeCommit: current, onCommitted: () => { committed = true; this.credentials = next; this.clearVerifiedTools(); this.closeFlow() } })
      this.pendingSave = saving; try { await saving } finally { if (this.pendingSave === saving) this.pendingSave = null }
      if (generation !== this.generation) return
      if (!committed) throw new Error('not committed')
      this.status = 'connecting'; this.emit(); await this.checkConnection(next.accessToken, generation)
    } catch (error) { if (generation === this.generation && this.flow === f) { if (error instanceof TikTokCredentialStorageError) this.storageBlocked = true; this.fail('授权连接失败，请重试') } }
  }
  private closeFlow(): void { if (!this.flow) return; clearTimeout(this.flow.timeout); this.flow.server.close(); this.flow = null; this.url = undefined }
  private async checkConnection(token: string, generation: number): Promise<boolean> {
    if (this.pendingVerification?.token === token && this.pendingVerification.generation === generation) return this.pendingVerification.promise
    const promise = this.performConnectionCheck(token, generation)
    this.pendingVerification = { token, generation, promise }
    try { return await promise } finally { if (this.pendingVerification?.promise === promise) this.pendingVerification = null }
  }
  private async performConnectionCheck(token: string, generation: number): Promise<boolean> {
    let tools: ToolDescription[] = []
    try { tools = await this.probe(token) } catch { /* provider errors can contain private data */ }
    if (generation !== this.generation || this.credentials?.accessToken !== token) return false
    const expected = ['get_apps', 'analytics_fetch_aggregated_data']
    const ok = tools.length === 2 && expected.every(name => tools.filter(t => t.name === name && !!t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)).length === 1)
    this.verifiedTools = ok ? structuredClone(tools) : []
    this.verifiedToken = ok ? token : null
    this.verified = ok
    this.status = ok ? 'connected' : 'degraded'
    this.error = ok ? undefined : 'AppsFlyer 已授权，但只读工具暂不可用，请检查权限或重试'
    if (ok) this.connectedAt = this.now()
    this.emit(); return ok
  }
  private clearVerifiedTools(): void { this.verified = false; this.verifiedToken = null; this.verifiedTools = [] }
  private fail(message: string): void { this.closeFlow(); this.status = this.credentials?.accessToken ? 'degraded' : 'failed'; this.error = message; this.emit() }
}
