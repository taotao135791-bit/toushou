import { LarkBrand } from '../../../shared/connections'

export interface RegistrationSession {
  brand: LarkBrand
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface RegistrationResult {
  clientId: string
  clientSecret: string
  tenantBrand?: LarkBrand
  ownerOpenId?: string
}

export interface FeishuAppRegistrationProvider {
  begin(brand: LarkBrand): Promise<RegistrationSession>
  poll(session: RegistrationSession, signal?: AbortSignal): Promise<RegistrationResult>
  cancel(session: RegistrationSession): Promise<void>
}

export interface RegistrationProviderOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

function endpoints(brand: LarkBrand): { accounts: string; open: string } {
  return brand === 'lark'
    ? { accounts: 'https://accounts.larksuite.com', open: 'https://open.larksuite.com' }
    : { accounts: 'https://accounts.feishu.cn', open: 'https://open.feishu.cn' }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text()
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error(`飞书连接服务返回了无法识别的响应（${response.status}）`)
  }
}

/**
 * Thin adapter around Feishu's PersonalAgent registration endpoint. The
 * endpoint is isolated behind this interface because it is experimental and
 * may be replaced by an official registration provider later.
 */
export class PersonalAgentRegistrationProvider implements FeishuAppRegistrationProvider {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number

  constructor(options: RegistrationProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? Date.now
  }

  async begin(brand: LarkBrand): Promise<RegistrationSession> {
    const domain = endpoints(brand)
    const response = await this.fetchWithTimeout(`${domain.accounts}/oauth/v1/app/registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id tenant_brand'
      }).toString()
    })
    const data = await parseJsonResponse(response)
    const error = text(data.error_description) || text(data.error)
    if (!response.ok || error) throw new Error(error || '暂时无法创建飞书连接，请稍后重试')

    const deviceCode = text(data.device_code)
    const userCode = text(data.user_code)
    const verificationUri = text(data.verification_uri) || `${domain.open}/page/cli`
    const verificationUriComplete =
      text(data.verification_uri_complete) || `${domain.open}/page/cli?user_code=${encodeURIComponent(userCode)}`
    if (!deviceCode || !userCode || !verificationUriComplete) {
      throw new Error('飞书连接服务返回的信息不完整，请稍后重试')
    }
    return {
      brand,
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: number(data.expires_in, 300),
      interval: number(data.interval, 5)
    }
  }

  async poll(session: RegistrationSession, signal?: AbortSignal): Promise<RegistrationResult> {
    const deadline = this.now() + session.expiresIn * 1000
    let interval = Math.max(1, session.interval)
    let attempts = 0
    while (this.now() < deadline && attempts < 200) {
      if (signal?.aborted) throw new Error('连接已取消')
      await this.sleep(interval * 1000, signal)
      attempts += 1
      const data = await this.pollOnce(session)
      const error = text(data.error)
      if (!error && text(data.client_id) && text(data.client_secret)) {
        const userInfo = (data.user_info ?? {}) as Record<string, unknown>
        const tenantBrand = userInfo.tenant_brand === 'lark' ? 'lark' : userInfo.tenant_brand === 'feishu' ? 'feishu' : undefined
        return {
          clientId: text(data.client_id),
          clientSecret: text(data.client_secret),
          tenantBrand,
          ownerOpenId: text(userInfo.open_id) || undefined
        }
      }
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        interval = Math.min(interval + 5, 60)
        continue
      }
      if (error === 'access_denied') throw new Error('你取消了飞书连接')
      if (error === 'expired_token' || error === 'invalid_grant') throw new Error('二维码已过期，请重新扫码')
      if (error) throw new Error(text(data.error_description) || error)
      interval = Math.min(interval + 1, 60)
    }
    throw new Error('二维码已过期，请重新扫码')
  }

  async cancel(session: RegistrationSession): Promise<void> {
    // The endpoint is best-effort; cancellation is primarily local so the
    // user can immediately generate a new QR code.
    try {
      const response = await this.fetchWithTimeout(`${endpoints(session.brand).accounts}/oauth/v1/app/registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'cancel', device_code: session.deviceCode }).toString()
      })
      await response.text()
    } catch {
      // Ignore network errors during cancellation.
    }
  }

  private async pollOnce(session: RegistrationSession): Promise<Record<string, unknown>> {
    const response = await this.fetchWithTimeout(`${endpoints(session.brand).accounts}/oauth/v1/app/registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'poll', device_code: session.deviceCode }).toString()
    })
    return parseJsonResponse(response)
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.fetchImpl(url, init),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('飞书连接服务请求超时')), 12_000)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('连接已取消'))
    }, { once: true })
  })
}
