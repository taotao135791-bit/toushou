import { describe, expect, it, vi } from 'vitest'
import { PersonalAgentRegistrationProvider } from './FeishuAppRegistration'

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
})
