import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { IPC_CHANNELS } from '../../../shared/constants'
import { ConnectionDefinition, ConnectionStatus, TikTokAdsConnectionSnapshot } from '../../../shared/connections'
import { McpStorePaths, defaultMcpStorePaths, removeMcpConnection, upsertManagedServer } from '../mcp/McpConnectionStore'
import { TikTokCredentialStore, TikTokStoredCredentials } from './TikTokCredentialStore'
import { TIKTOK_ADS_SKILL_FILE_NAME, TIKTOK_ADS_SKILL_MARKDOWN } from './tiktokAdsSkill'

/**
 * TikTok Ads MCP first-party connector.
 *
 * The official server (business-api.tiktok.com/open_mcp/tt-ads-mcp-layer) is
 * a Streamable-HTTP MCP endpoint protected by OAuth 2.1 with dynamic client
 * registration — per the official "How to connect" docs, no developer app or
 * API key is needed. The runtime (OMP) can declare `auth: {type:'oauth'}` in
 * mcp.json but cannot complete a browser authorization from its RPC mode, so
 * the server would be silently skipped. 投手 therefore owns the flow:
 *
 *   discover → register (RFC 7591) → PKCE + loopback redirect → browser auth
 *   → token exchange → safeStorage envelope → mcp.json entry with a bearer
 *   header → bundled skill installed into the library.
 *
 * Tokens live ONLY in the encrypted envelope; the mcp.json entry is the one
 * place a bearer reaches disk (same trust level as a pasted MCP token). The
 * renderer receives snapshots without any secret material.
 */

const MCP_SERVER_NAME = 'tiktok-ads'
const MCP_ENDPOINT = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer'
const PROTECTED_RESOURCE_WELL_KNOWN =
  'https://business-api.tiktok.com/.well-known/oauth-protected-resource/open_mcp/tt-ads-mcp-layer'
const DEFAULT_SCOPE = 'mcp:tt4b'
/** Refresh this long before expiry so a spawned session never sees a stale bearer. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000
const FLOW_TIMEOUT_MS = 10 * 60 * 1000

const TIKTOK_DEFINITION: ConnectionDefinition = {
  id: 'tiktok-ads',
  kind: 'oauth',
  label: 'TikTok Ads',
  description: '把投手接入 TikTok 广告的官方 MCP：查账户报表、管 Smart+ 广告、诊断投放。',
  capabilities: ['mcp']
}

interface OAuthEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  scope: string
}

interface PendingFlow {
  endpoints: OAuthEndpoints
  clientId: string
  clientSecret?: string
  codeVerifier: string
  state: string
  redirectUri: string
  server: ReturnType<typeof createServer>
  timeout: ReturnType<typeof setTimeout>
}

export interface TikTokFetch {
  (url: string, init?: RequestInit): Promise<Response>
}

export class TikTokAdsConnectionManager {
  private readonly credentialStore: TikTokCredentialStore
  private readonly mcpPaths: McpStorePaths
  private readonly fetchImpl: TikTokFetch
  private readonly openExternal: (url: string) => Promise<void>
  private readonly now: () => number
  private credentials: TikTokStoredCredentials | null = null
  private flow: PendingFlow | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private state: 'idle' | 'discovering' | 'waiting_for_user' | 'connected' | 'degraded' | 'failed' = 'idle'
  private lastError: string | undefined
  private lastConnectedAt: number | undefined
  /** Authorize URL while waiting for the browser round-trip (renderer shows a manual-open link). */
  private authorizationUrl: string | undefined

  constructor(options: {
    credentialStore?: TikTokCredentialStore
    mcpPaths?: McpStorePaths
    fetchImpl?: TikTokFetch
    openExternal?: (url: string) => Promise<void>
    now?: () => number
  } = {}) {
    this.credentialStore = options.credentialStore ?? new TikTokCredentialStore()
    this.mcpPaths = options.mcpPaths ?? defaultMcpStorePaths()
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.now = options.now ?? Date.now
  }

  /** App-start hook: restore a stored connection (self-healing the mcp entry). */
  async initialize(): Promise<void> {
    this.credentials = await this.credentialStore.load()
    if (!this.credentials) return
    this.state = 'connected'
    this.lastConnectedAt = this.now()
    await this.applyMcpEntry()
    void this.ensureFreshToken()
    this.emitState()
  }

  getSnapshot(): TikTokAdsConnectionSnapshot {
    return {
      definition: TIKTOK_DEFINITION,
      status: this.snapshotStatus(),
      connected: this.state === 'connected',
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      tokenExpiresAt: this.credentials?.expiresAt,
      ...(this.state === 'waiting_for_user' && this.authorizationUrl ? { authorizationUrl: this.authorizationUrl } : {})
    }
  }

  private snapshotStatus(): ConnectionStatus {
    switch (this.state) {
      case 'idle':
        return 'disconnected'
      case 'discovering':
        return 'connecting'
      case 'waiting_for_user':
        return 'waiting_for_user'
      case 'connected':
        return 'connected'
      case 'degraded':
        return 'degraded'
      case 'failed':
        return 'failed'
    }
  }

  /** Begin the browser authorization flow. Errors surface via the snapshot. */
  async begin(): Promise<TikTokAdsConnectionSnapshot> {
    if (this.flow) return this.getSnapshot()
    this.state = 'discovering'
    this.lastError = undefined
    this.emitState()
    try {
      const endpoints = await this.discover()
      const registration = await this.registerClient(endpoints)
      const { verifier, challenge } = pkcePair()
      const state = base64url(randomBytes(24))
      const loopback = await this.listenForCallback()
      const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
      const url = new URL(endpoints.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', registration.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', endpoints.scope)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('resource', MCP_ENDPOINT)
      this.flow = {
        endpoints,
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        codeVerifier: verifier,
        state,
        redirectUri,
        server: loopback.server,
        timeout: setTimeout(() => void this.failFlow('授权超时，请重试'), FLOW_TIMEOUT_MS)
      }
      this.authorizationUrl = url.toString()
      this.state = 'waiting_for_user'
      this.emitState()
      await this.openExternal(this.authorizationUrl)
    } catch (error) {
      this.failFlowFlowSafe(error)
    }
    return this.getSnapshot()
  }

  cancel(): TikTokAdsConnectionSnapshot {
    this.closeFlow()
    this.state = this.credentials ? 'connected' : 'idle'
    this.emitState()
    return this.getSnapshot()
  }

  async disconnect(): Promise<TikTokAdsConnectionSnapshot> {
    this.closeFlow()
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    await this.credentialStore.clear()
    this.credentials = null
    this.lastError = undefined
    removeMcpConnection(MCP_SERVER_NAME, this.mcpPaths)
    // The installed skill stays: it documents tools the user may re-connect.
    this.state = 'idle'
    this.emitState()
    return this.getSnapshot()
  }

  /** Renderer-initiated manual open of the authorize page (validated https). */
  async openAuthorizationUrl(url: string): Promise<boolean> {
    if (this.state !== 'waiting_for_user' || url !== this.authorizationUrl) return false
    try {
      await this.openExternal(url)
      return true
    } catch {
      return false
    }
  }

  /**
   * Refresh the access token when it is inside the margin; reschedules
   * itself and rewrites the mcp entry. A failed refresh degrades the
   * connection loudly instead of letting the runtime silently drop the
   * server behind an expired bearer.
   */
  async ensureFreshToken(): Promise<boolean> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    const credentials = this.credentials
    if (!credentials?.refreshToken) return false
    const expiresAt = credentials.expiresAt ?? 0
    const remaining = expiresAt - this.now()
    if (remaining > REFRESH_MARGIN_MS) {
      this.refreshTimer = setTimeout(() => void this.ensureFreshToken(), remaining - REFRESH_MARGIN_MS)
      return true
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId
      })
      if (credentials.clientSecret) body.set('client_secret', credentials.clientSecret)
      const tokens = await this.tokenRequest(this.refreshTokenEndpoint(credentials), body)
      this.credentials = { ...credentials, ...tokens, savedAt: 0 }
      await this.credentialStore.save(this.credentials)
      await this.applyMcpEntry()
      this.state = 'connected'
      this.lastError = undefined
      this.scheduleNextRefresh()
      this.emitState()
      return true
    } catch (error) {
      this.state = 'degraded'
      this.lastError = `令牌刷新失败：${friendlyError(error)}（请重新授权）`
      this.emitState()
      return false
    }
  }

  /** Install the bundled skill into the flat library folder (idempotent). */
  installSkill(): { ok: boolean; error?: string } {
    try {
      const dir = path.join(app.getPath('userData'), 'skills')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, TIKTOK_ADS_SKILL_FILE_NAME)
      let current: string | null = null
      try {
        current = readFileSync(file, 'utf-8')
      } catch {
        current = null
      }
      if (current !== TIKTOK_ADS_SKILL_MARKDOWN) writeFileSync(file, TIKTOK_ADS_SKILL_MARKDOWN, 'utf-8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: friendlyError(error) }
    }
  }

  // ------------------------------------------------------------------ oauth plumbing

  private async discover(): Promise<OAuthEndpoints> {
    const resource = await this.fetchJson(PROTECTED_RESOURCE_WELL_KNOWN).catch((error) => {
      throw new Error(`TikTok OAuth 发现失败（${friendlyError(error)}）`)
    })
    const servers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers : []
    const issuer = typeof servers[0] === 'string' ? servers[0] : ''
    if (!/^https:\/\//.test(issuer)) throw new Error('TikTok OAuth 发现失败（authorization_servers 缺失）')
    const metadata = await this.fetchJson(`${issuer}/.well-known/oauth-authorization-server`)
    const authorizationEndpoint = typeof metadata.authorization_endpoint === 'string' ? metadata.authorization_endpoint : ''
    const tokenEndpoint = typeof metadata.token_endpoint === 'string' ? metadata.token_endpoint : ''
    const registrationEndpoint = typeof metadata.registration_endpoint === 'string' ? metadata.registration_endpoint : ''
    if (!/^https:\/\//.test(authorizationEndpoint) || !/^https:\/\//.test(tokenEndpoint)) {
      throw new Error('TikTok OAuth 端点元数据不完整')
    }
    const scopes = Array.isArray(resource.scopes_supported) ? resource.scopes_supported : []
    return {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      scope: typeof scopes[0] === 'string' && scopes[0] ? scopes[0] : DEFAULT_SCOPE
    }
  }

  /**
   * Dynamic client registration (RFC 7591). Loopback redirect URIs are tried
   * most-specific first; RFC 8252 permits port variance for 127.0.0.1, so a
   * port-less registration still authorizes an exact-port redirect_uri.
   */
  private async registerClient(endpoints: OAuthEndpoints): Promise<{ clientId: string; clientSecret?: string }> {
    if (!endpoints.registrationEndpoint) {
      throw new Error('TikTok 未提供动态注册端点，无法自动创建客户端')
    }
    const attempts = [
      'http://127.0.0.1/callback',
      'http://localhost/callback'
    ]
    let lastError = '动态客户端注册失败'
    for (const redirectUri of attempts) {
      const response = await this.fetchImpl(endpoints.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Toushou (投手)',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }),
        signal: AbortSignal.timeout(15_000)
      })
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      if (response.ok && typeof payload.client_id === 'string' && payload.client_id) {
        return {
          clientId: payload.client_id,
          clientSecret: typeof payload.client_secret === 'string' && payload.client_secret ? payload.client_secret : undefined
        }
      }
      lastError = typeof payload.error_description === 'string'
        ? payload.error_description
        : typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
    }
    throw new Error(`动态客户端注册失败：${lastError}`)
  }

  private listenForCallback(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => void this.handleCallback(request, response))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('loopback 回调端口分配失败'))
          return
        }
        resolve({ server, port: address.port })
      })
    })
  }

  private handleCallback(request: IncomingMessage, response: ServerResponse): void {
    const flow = this.flow
    if (!flow) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h3>没有进行中的 TikTok 授权流程</h3>')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const stateMatches = !!state && safeEqual(state, flow.state)
    if (error || !code || !stateMatches) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h3>授权失败</h3><p>请回到投手重新发起连接。</p>')
      this.failFlow(error ? `TikTok 授权被拒绝（${error}）` : '回调缺少授权码或 state 校验失败')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<h3>授权成功</h3><p>请回到投手继续。</p>')
    void this.exchangeCode(code)
  }

  private async exchangeCode(code: string): Promise<void> {
    const flow = this.flow
    if (!flow) return
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.codeVerifier
      })
      if (flow.clientSecret) body.set('client_secret', flow.clientSecret)
      const tokens = await this.tokenRequest(flow.endpoints.tokenEndpoint, body)
      this.closeFlow()
      this.credentials = {
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        tokenEndpoint: flow.endpoints.tokenEndpoint,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        savedAt: 0
      }
      await this.credentialStore.save(this.credentials)
      await this.applyMcpEntry()
      this.installSkill()
      this.state = 'connected'
      this.lastError = undefined
      this.lastConnectedAt = this.now()
      this.scheduleNextRefresh()
      this.emitState()
    } catch (error) {
      this.failFlow(`授权码交换失败：${friendlyError(error)}`)
    }
  }

  private async tokenRequest(
    tokenEndpoint: string,
    body: URLSearchParams
  ): Promise<{ accessToken?: string; refreshToken?: string; expiresAt?: number; scope?: string }> {
    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000)
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) {
      const detail = typeof payload.error_description === 'string'
        ? payload.error_description
        : typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
      throw new Error(detail)
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
      expiresAt: expiresIn ? this.now() + expiresIn * 1000 : undefined,
      scope: typeof payload.scope === 'string' ? payload.scope : undefined
    }
  }

  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as Record<string, unknown>
  }

  /** Refresh endpoint: the one persisted at connect time, else the documented issuer default. */
  private refreshTokenEndpoint(credentials: TikTokStoredCredentials): string {
    return credentials.tokenEndpoint ?? 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer/oauth/token'
  }

  private async applyMcpEntry(): Promise<void> {
    const token = this.credentials?.accessToken
    if (!token) return
    const result = upsertManagedServer(
      MCP_SERVER_NAME,
      {
        type: 'http',
        url: MCP_ENDPOINT,
        timeout: 120000,
        headers: { Authorization: `Bearer ${token}` }
      },
      this.mcpPaths
    )
    if (!result.ok) {
      this.state = 'degraded'
      this.lastError = `写入 mcp.json 失败：${result.error}`
      this.emitState()
    }
  }

  private scheduleNextRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const expiresAt = this.credentials?.expiresAt
    if (!expiresAt || !this.credentials?.refreshToken) return
    const delay = Math.max(expiresAt - REFRESH_MARGIN_MS - this.now(), 60_000)
    this.refreshTimer = setTimeout(() => void this.ensureFreshToken(), delay)
  }

  private closeFlow(): void {
    if (!this.flow) return
    clearTimeout(this.flow.timeout)
    try {
      this.flow.server.close()
    } catch {
      // already closed — fine
    }
    this.flow = null
    this.authorizationUrl = undefined
  }

  private failFlow(message: string): void {
    this.closeFlow()
    this.state = this.credentials ? 'degraded' : 'failed'
    this.lastError = message
    this.emitState()
  }

  private failFlowFlowSafe(error: unknown): void {
    this.failFlow(friendlyError(error))
  }

  private emitState(): void {
    const snapshot = this.getSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.TIKTOK_STATUS, snapshot)
    }
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function friendlyError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200)
  return String(error).slice(0, 200)
}
