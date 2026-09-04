import { FeishuCapability, LarkBrand } from '../../../shared/connections'
import { FeishuCredentialStore } from './FeishuCredentialStore'

export interface FeishuOAuthAuthorization {
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
}

interface PendingOAuth {
  deviceCode: string
  interval: number
  expiresIn: number
  brand: LarkBrand
}

const SCOPE_BY_CAPABILITY: Partial<Record<FeishuCapability, string>> = {
  'docs.read': 'docx:document:readonly',
  'docs.write': 'docx:document',
  'sheets.read': 'sheets:spreadsheet:readonly',
  'sheets.write': 'sheets:spreadsheet',
  'bitable.read': 'bitable:app:readonly',
  'bitable.write': 'bitable:app',
  'calendar.read': 'calendar:calendar:readonly',
  'calendar.write': 'calendar:calendar',
  tasks: 'task:task:readonly',
  drive: 'drive:drive:readonly'
}

/** On-demand user OAuth kept entirely in Main; tokens live in the secure store. */
export class FeishuOAuthManager {
  private pending: PendingOAuth | null = null

  constructor(private readonly store: FeishuCredentialStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async authorizedCapabilities(): Promise<FeishuCapability[]> {
    const credentials = await this.store.load()
    const capabilities: FeishuCapability[] = ['messaging']
    if (!credentials?.accessToken || !credentials.expiresAt || credentials.expiresAt <= Date.now()) return capabilities
    const scopes = new Set((credentials.scope ?? '').split(/[\s,]+/).filter(Boolean))
    for (const [capability, scope] of Object.entries(SCOPE_BY_CAPABILITY)) {
      if (scope && scopes.has(scope)) capabilities.push(capability as FeishuCapability)
    }
    return capabilities
  }

  async ensureFreshToken(): Promise<boolean> {
    const credentials = await this.store.load()
    if (!credentials?.accessToken) return false
    if ((credentials.expiresAt ?? 0) > Date.now() + 5 * 60 * 1000) return true
    if (!credentials.refreshToken || (credentials.refreshExpiresAt ?? 0) <= Date.now()) return false
    const base = openBase(credentials.brand)
    const response = await this.fetchImpl(`${base}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.appId,
        client_secret: credentials.appSecret,
        refresh_token: credentials.refreshToken
      }).toString()
    })
    const data = await response.json() as Record<string, unknown>
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (!response.ok || !accessToken) return false
    await this.store.save({
      ...credentials,
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : credentials.refreshToken,
      expiresAt: Date.now() + number(data.expires_in, 7200) * 1000,
      refreshExpiresAt: Date.now() + number(data.refresh_token_expires_in, 604800) * 1000,
      scope: typeof data.scope === 'string' ? data.scope : credentials.scope
    })
    return true
  }

  async accessTokenFor(capability: FeishuCapability): Promise<string | null> {
    if (!(await this.ensureFreshToken())) return null
    const credentials = await this.store.load()
    if (!credentials?.accessToken) return null
    const scope = SCOPE_BY_CAPABILITY[capability]
    const scopes = new Set((credentials.scope ?? '').split(/[\s,]+/).filter(Boolean))
    return scope && scopes.has(scope) ? credentials.accessToken : null
  }

  async begin(capability: FeishuCapability): Promise<FeishuOAuthAuthorization> {
    const credentials = await this.store.load()
    if (!credentials) throw new Error('飞书尚未连接')
    const scope = `${SCOPE_BY_CAPABILITY[capability] ?? ''} offline_access`.trim()
    const response = await this.fetchImpl(`${accountsBase(credentials.brand)}/oauth/v1/device_authorization`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.appId}:${credentials.appSecret}`).toString('base64')}`
      },
      body: new URLSearchParams({ client_id: credentials.appId, scope }).toString()
    })
    const data = await response.json() as Record<string, unknown>
    if (!response.ok || typeof data.device_code !== 'string') throw new Error('暂时无法申请额外权限')
    const verificationUri = typeof data.verification_uri === 'string' ? data.verification_uri : `${openBase(credentials.brand)}/page/cli`
    const complete = typeof data.verification_uri_complete === 'string'
      ? data.verification_uri_complete
      : `${verificationUri}?user_code=${encodeURIComponent(String(data.user_code ?? ''))}`
    this.pending = {
      deviceCode: data.device_code,
      interval: number(data.interval, 5),
      expiresIn: number(data.expires_in, 240),
      brand: credentials.brand
    }
    return { verificationUri, verificationUriComplete: complete, expiresAt: Date.now() + this.pending.expiresIn * 1000 }
  }

  async poll(): Promise<boolean> {
    const pending = this.pending
    const credentials = await this.store.load()
    if (!pending || !credentials) return false
    const deadline = Date.now() + pending.expiresIn * 1000
    let interval = pending.interval
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
      const response = await this.fetchImpl(`${openBase(pending.brand)}/open-apis/authen/v2/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: credentials.appId,
          client_secret: credentials.appSecret
        }).toString()
      })
      const data = await response.json() as Record<string, unknown>
      const error = typeof data.error === 'string' ? data.error : ''
      if (typeof data.access_token === 'string' && data.access_token) {
        await this.store.save({
          ...credentials,
          accessToken: data.access_token,
          refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
          expiresAt: Date.now() + number(data.expires_in, 7200) * 1000,
          refreshExpiresAt: Date.now() + number(data.refresh_token_expires_in, 604800) * 1000,
          scope: typeof data.scope === 'string' ? data.scope : ''
        })
        this.pending = null
        return true
      }
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') { interval = Math.min(interval + 5, 60); continue }
      this.pending = null
      return false
    }
    this.pending = null
    return false
  }

  cancel(): void {
    this.pending = null
  }
}

function accountsBase(brand: LarkBrand): string {
  return brand === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn'
}

function openBase(brand: LarkBrand): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
