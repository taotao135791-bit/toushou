import { describe, expect, it, vi } from 'vitest'
import { FEISHU_CAPABILITY_SCOPES } from '../../../shared/connections'
import type { FeishuCredentialStore, FeishuStoredCredentials } from './FeishuCredentialStore'
import { FeishuOAuthManager } from './FeishuOAuthManager'

const docWrite = FEISHU_CAPABILITY_SCOPES['docs.write'].scope
const docMedia = FEISHU_CAPABILITY_SCOPES['docs.media'].scope
const sheetsRead = FEISHU_CAPABILITY_SCOPES['sheets.read'].scope

function fixture(scope: string) {
  let credentials: FeishuStoredCredentials = {
    appId: 'cli_synthetic', appSecret: 'synthetic', brand: 'feishu', savedAt: 0,
    scope, accessToken: 'user-token', expiresAt: Date.now() + 60 * 60 * 1000
  }
  const store = { load: async () => credentials, save: async (value: FeishuStoredCredentials) => { credentials = value } }
  const fetchImpl = vi.fn<typeof fetch>()
  const manager = new FeishuOAuthManager(store as unknown as FeishuCredentialStore, fetchImpl)
  return { manager, fetchImpl }
}

describe('Feishu document attachment authorization', () => {
  it('requests both required scopes and keeps existing known grants in the request', async () => {
    const { manager, fetchImpl } = fixture(sheetsRead + ' unknown_scope')
    fetchImpl.mockResolvedValueOnce(Response.json({ device_code: 'fake-device' }))
    await manager.begin('docs.media')
    const body = new URLSearchParams(String(fetchImpl.mock.lastCall?.[1]?.body))
    expect(new Set(body.get('scope')?.split(' '))).toEqual(new Set([docWrite, docMedia, sheetsRead, 'offline_access']))
  })

  it('only exposes media access when the same returned user grant contains both scopes', async () => {
    for (const scope of [docWrite, docMedia]) {
      const { manager } = fixture(scope)
      expect(await manager.authorizedCapabilities()).not.toContain('docs.media')
      expect(await manager.accessTokenFor('docs.media')).toBeNull()
    }
    const { manager } = fixture(docWrite + ' ' + docMedia)
    expect(await manager.authorizedCapabilities()).toEqual(expect.arrayContaining(['docs.media', 'docs.write']))
    expect(await manager.accessTokenFor('docs.media')).toBe('user-token')
  })

  it('trusts only scopes actually returned after the user consents', async () => {
    const { manager, fetchImpl } = fixture(sheetsRead)
    fetchImpl.mockResolvedValueOnce(Response.json({ device_code: 'fake-device', interval: 0.001 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'new-user-token', scope: docMedia }))
    await manager.begin('docs.media')
    expect(await manager.poll()).toBe(true)
    expect(await manager.authorizedCapabilities()).toEqual(['messaging'])
    expect(await manager.accessTokenFor('docs.media')).toBeNull()
  })
})
