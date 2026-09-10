import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { PersonalAgentRegistrationProvider, encodeRegistrationAddons } from './FeishuAppRegistration'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('PersonalAgentRegistrationProvider', () => {
  it('starts registration with the PersonalAgent contract', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
      expect(init?.method).toBe('POST')
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('action')).toBe('begin')
      expect(form.get('archetype')).toBe('PersonalAgent')
      expect(form.get('auth_method')).toBe('client_secret')
      expect(form.get('request_user_info')).toContain('open_id')
      return response({
        device_code: 'device-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://open.feishu.cn/page/cli',
        verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=ABCD-EFGH',
        expires_in: 300,
        interval: 1
      })
    }) as unknown as typeof fetch
    const provider = new PersonalAgentRegistrationProvider({ fetchImpl })
    await expect(provider.begin('feishu')).resolves.toMatchObject({
      deviceCode: 'device-1',
      userCode: 'ABCD-EFGH',
      verificationUriComplete: 'https://open.feishu.cn/page/cli?user_code=ABCD-EFGH'
    })
  })

  it('polls pending and slowdown responses, then returns credentials and owner', async () => {
    const replies = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { client_id: 'cli_test', client_secret: 'secret-value', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } }
    ]
    const fetchImpl = vi.fn(async () => response(replies.shift() ?? {}))
    const provider = new PersonalAgentRegistrationProvider({ fetchImpl, sleep: async () => undefined, now: () => 1_000 })
    await expect(provider.poll({
      brand: 'feishu', deviceCode: 'device-1', userCode: 'ABCD',
      verificationUri: 'https://open.feishu.cn/page/cli',
      verificationUriComplete: 'https://open.feishu.cn/page/cli?user_code=ABCD',
      expiresIn: 300, interval: 1
    })).resolves.toEqual({
      clientId: 'cli_test', clientSecret: 'secret-value', tenantBrand: 'feishu', ownerOpenId: 'ou_owner'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps denied and expired device flows to safe user errors', async () => {
    const provider = new PersonalAgentRegistrationProvider({
      fetchImpl: vi.fn(async () => response({ error: 'access_denied' })),
      sleep: async () => undefined,
      now: () => 1_000
    })
    const session = {
      brand: 'lark' as const, deviceCode: 'device-1', userCode: 'ABCD',
      verificationUri: 'https://open.larksuite.com/page/cli',
      verificationUriComplete: 'https://open.larksuite.com/page/cli?user_code=ABCD',
      expiresIn: 300, interval: 1
    }
    await expect(provider.poll(session)).rejects.toThrow('取消了飞书连接')
    const expired = new PersonalAgentRegistrationProvider({
      fetchImpl: vi.fn(async () => response({ error: 'expired_token' })),
      sleep: async () => undefined,
      now: () => 1_000
    })
    await expect(expired.poll(session)).rejects.toThrow('二维码已过期')
  })

  it('encodes addons with the official gzip+base64url pipeline', () => {
    const scopes = ['docx:document:readonly', 'calendar:calendar']
    const encoded = encodeRegistrationAddons(scopes)
    // URL-safe, unpadded — safe to drop straight into a query param.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'))
    expect(decoded).toEqual({ scopes: { user: scopes } })
    // An effectively-empty payload must not be sent at all: the confirm page
    // discards the whole addons payload on shape mismatch.
    expect(encodeRegistrationAddons([])).toBe('')
    expect(encodeRegistrationAddons(['  '])).toBe('')
  })

  it('decorates the verification URL with update mode and pre-filled scopes', async () => {
    const scopes = ['bitable:app:readonly', 'task:task:readonly']
    const fetchImpl = vi.fn(async () => response({
      device_code: 'device-2',
      user_code: 'WXYZ',
      verification_uri: 'https://open.feishu.cn/page/cli',
      verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=WXYZ',
      expires_in: 300,
      interval: 1
    })) as unknown as typeof fetch
    const provider = new PersonalAgentRegistrationProvider({ fetchImpl })
    const session = await provider.begin('feishu', { appId: 'cli_existing', userScopes: scopes })
    const url = new URL(session.verificationUriComplete)
    expect(url.searchParams.get('user_code')).toBe('WXYZ')
    expect(url.searchParams.get('clientID')).toBe('cli_existing')
    const addons = url.searchParams.get('addons') ?? ''
    expect(JSON.parse(gunzipSync(Buffer.from(addons, 'base64')).toString('utf8'))).toEqual({
      scopes: { user: scopes }
    })
  })

  it('keeps the verification URL untouched without repair options', async () => {
    const fetchImpl = vi.fn(async () => response({
      device_code: 'device-3',
      user_code: 'PLAIN',
      verification_uri: 'https://open.feishu.cn/page/cli',
      verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=PLAIN',
      expires_in: 300,
      interval: 1
    })) as unknown as typeof fetch
    const provider = new PersonalAgentRegistrationProvider({ fetchImpl })
    const session = await provider.begin('feishu')
    expect(session.verificationUriComplete).toBe('https://open.feishu.cn/page/cli?user_code=PLAIN')
  })
})
