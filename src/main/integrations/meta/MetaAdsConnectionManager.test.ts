import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TikTokStoredCredentials } from '../tiktok/TikTokCredentialStore'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/synthetic-meta-ads-test' }, shell: { openExternal: vi.fn() }, session: { fromPartition: vi.fn() }, safeStorage: {} }))
import { META_ADS_RESOURCE, META_ADS_ISSUER, META_ADS_RESOURCE_METADATA, META_ADS_AUTH_METADATA, META_ADS_AUTHORIZE, META_ADS_TOKEN, META_ADS_REGISTER } from './constants'
import { MetaAdsConnectionManager } from './MetaAdsConnectionManager'
import { TikTokCredentialStorageError } from '../tiktok/tiktokCredentialStorageError'
const managers: MetaAdsConnectionManager[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const manager of managers.splice(0)) manager.cancel() })
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })
const flush = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); expect(predicate()).toBe(true) }
function fixture(probe: (token: string) => Promise<boolean> = async () => true, now: () => number = Date.now) {
  let saved: TikTokStoredCredentials | null = null
  let release: (() => void) | undefined
  let blockSave = false
  const store = {
    load: vi.fn(async () => saved), retry: vi.fn(async () => saved), sharedStorageBlockedEpoch: () => null,
    clear: vi.fn(async () => { saved = null }),
    save: vi.fn(async (c: Omit<TikTokStoredCredentials, 'savedAt'>, options?: { beforeCommit?: () => boolean; onCommitted?: () => void }) => { if (blockSave) await new Promise<void>(r => { release = r }); if (options?.beforeCommit && !options.beforeCommit()) throw new Error('cancelled'); saved = { ...c, savedAt: 1 }; options?.onCommitted?.() })
  }
  let opened = ''
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === META_ADS_RESOURCE_METADATA) return json({ resource: META_ADS_RESOURCE, authorization_servers: [META_ADS_ISSUER] })
    if (url === META_ADS_AUTH_METADATA) return json({ issuer: META_ADS_ISSUER, authorization_endpoint: META_ADS_AUTHORIZE, token_endpoint: META_ADS_TOKEN, registration_endpoint: META_ADS_REGISTER, token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] })
    if (url === META_ADS_REGISTER) { expect(JSON.parse(String(_init?.body)).scope).toBe('mcp:read'); return json({ client_id: 'synthetic-pipeboard-client' }) }
    if (url === META_ADS_TOKEN) return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'mcp:read' })
    throw new Error('unexpected')
  })
  const manager = new MetaAdsConnectionManager({ callbackPort: 0, credentialStore: store, fetchImpl, now, probe: async token => await probe(token) ? [{ name: 'get_ad_accounts', inputSchema: { type: 'object' } }, { name: 'get_insights', inputSchema: { type: 'object' } }] : [], openExternal: async url => { opened = url } })
  managers.push(manager)
  return { manager, store, fetchImpl, opened: () => opened, saved: () => saved, block: () => { blockSave = true }, release: () => release?.() }
}
async function callback(url: string, state: string, code = 'synthetic-code') { const origin = new URL(new URL(url).searchParams.get('redirect_uri')!).origin; return fetch(`${origin}/callback?state=${encodeURIComponent(state)}&code=${code}`) }
describe('MetaAds OAuth', () => {
  it('uses PKCE, ignores unrelated callbacks, and stores a successful grant', async () => {
    const f = fixture(); await f.manager.initialize(); await f.manager.begin()
    const auth = new URL(f.opened()); expect(auth.searchParams.get('scope')).toBe('mcp:read'); expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect((await callback(f.opened(), 'wrong')).status).toBe(400)
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    expect((await callback(f.opened(), auth.searchParams.get('state')!)).status).toBe(200)
    await flush(() => f.manager.getSnapshot().connected)
    expect(await f.manager.loadFreshCredentials()).toEqual({ accessToken: 'synthetic-access' })
    expect(JSON.stringify(f.manager.getSnapshot())).not.toContain('synthetic-secret')
    expect(f.store.save).toHaveBeenCalledTimes(1)
    const tokenRequest = f.fetchImpl.mock.calls.find(([url]) => url === META_ADS_TOKEN)!
    const body = new URLSearchParams(String(tokenRequest[1]?.body))
    expect(body.get('client_id')).toBe(auth.searchParams.get('client_id'))
    expect(body.get('redirect_uri')).toBe(auth.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'))
    expect(body.has('client_secret')).toBe(false)
    await f.manager.disconnect(); expect(f.saved()).toBeNull()
  })
  it('uses the verified cached schema until refresh or an authorization failure', async () => {
    let clock = 1_000; const probe = vi.fn(async () => true); const f = fixture(probe, () => clock)
    await f.manager.begin(); const auth = new URL(f.opened()); await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.manager.getSnapshot().connected)
    const schema = await f.manager.getVerifiedToolDescriptions(); expect(schema).toHaveLength(2)
    schema![0].name = 'mutated'
    expect((await f.manager.getVerifiedToolDescriptions())?.[0].name).toBe('get_ad_accounts')
    expect(probe).toHaveBeenCalledTimes(1)
    clock += 3_600_000
    const fresh = await Promise.all([f.manager.getVerifiedToolDescriptions(), f.manager.getVerifiedToolDescriptions()])
    expect(fresh[0]).toHaveLength(2); expect(probe).toHaveBeenCalledTimes(2)
    f.manager.markReadFailure(new Error('meta-ads-authorization-error'), 'synthetic-access')
    expect(await f.manager.getVerifiedToolDescriptions()).toBeNull(); expect(f.manager.hasVerifiedTools()).toBe(false)
    await f.manager.disconnect(); expect(await f.manager.getVerifiedToolDescriptions()).toBeNull()
  })
  it('does not commit a delayed grant after cancellation', async () => {
    const f = fixture(); f.block(); await f.manager.begin()
    const auth = new URL(f.opened()); await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.store.save.mock.calls.length === 1)
    expect((await callback(f.opened(), auth.searchParams.get('state')!)).status).toBe(202)
    expect(f.store.save).toHaveBeenCalledTimes(1)
    f.manager.cancel(); f.release(); await flush(() => f.manager.getSnapshot().status === 'disconnected')
    await new Promise(r => setTimeout(r, 15)); expect(f.saved()).toBeNull()
  })
  it('waits for pending save before disconnect and never restores the old grant', async () => {
    const f = fixture(); f.block(); await f.manager.begin()
    const auth = new URL(f.opened()); await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.store.save.mock.calls.length === 1)
    const disconnect = f.manager.disconnect(); expect(f.store.clear).not.toHaveBeenCalled()
    f.release(); await disconnect
    expect(f.saved()).toBeNull(); expect(f.store.clear).toHaveBeenCalledTimes(1)
    expect(f.manager.getSnapshot().status).toBe('disconnected')
  })
  it('waits for the entire disconnect before starting another authorization', async () => {
    const f = fixture(); let unblock!: () => void
    f.store.clear.mockImplementationOnce(async () => { await new Promise<void>(resolve => { unblock = resolve }) })
    const disconnect = f.manager.disconnect(); await flush(() => typeof unblock === 'function')
    const begin = f.manager.begin(); expect(f.fetchImpl).not.toHaveBeenCalled()
    unblock(); await disconnect; await begin
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user'); f.manager.cancel()
  })
  it('restores a recovered encrypted grant without starting a new OAuth flow', async () => {
    const f = fixture()
    const oldGrant = { clientId: 'synthetic-client', accessToken: 'synthetic-access', savedAt: 1 }
    f.store.load.mockRejectedValueOnce(new TikTokCredentialStorageError())
    f.store.retry.mockResolvedValueOnce(oldGrant)
    await f.manager.initialize(); expect(f.manager.getSnapshot().status).toBe('degraded')
    await f.manager.begin()
    expect(f.manager.getSnapshot().connected).toBe(true)
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.opened()).toBe('')
  })
  it('blocks new reads during disconnect and ignores a stale authorization failure', async () => {
    const f = fixture()
    f.store.load.mockResolvedValueOnce({ clientId: 'synthetic-client', accessToken: 'synthetic-new', savedAt: 1 })
    await f.manager.initialize(); expect(f.manager.getSnapshot().connected).toBe(true)
    f.manager.markReadFailure(new Error('meta-ads-authorization-error'), 'synthetic-old')
    expect(f.manager.getSnapshot().connected).toBe(true)
    let unblock!: () => void
    f.store.clear.mockImplementationOnce(async () => { await new Promise<void>(resolve => { unblock = resolve }) })
    const disconnect = f.manager.disconnect(); await flush(() => typeof unblock === 'function')
    expect(await f.manager.loadFreshCredentials()).toBeNull()
    f.manager.markReadFailure(new Error('meta-ads-authorization-error'), 'synthetic-new')
    unblock(); await disconnect
    f.manager.markReadFailure(new Error('meta-ads-authorization-error'), 'synthetic-new')
    expect(f.manager.getSnapshot().status).toBe('disconnected')
  })
  it('does not reuse the previous grant verification after a new grant is saved', async () => {
    let resolveProbe!: (ok: boolean) => void
    let probes = 0
    const f = fixture(async () => { probes++; return probes === 1 ? true : await new Promise<boolean>(resolve => { resolveProbe = resolve }) })
    f.store.load.mockResolvedValueOnce({ clientId: 'synthetic-client', accessToken: 'synthetic-old', savedAt: 1 })
    await f.manager.initialize(); expect(f.manager.getSnapshot().connected).toBe(true)
    await f.manager.begin(); const auth = new URL(f.opened())
    await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => typeof resolveProbe === 'function')
    expect(f.manager.cancel().status).toBe('degraded')
    resolveProbe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.manager.getSnapshot().status).toBe('degraded')
  })
  it('rejects untrusted OAuth endpoints without opening a browser', async () => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => json({ authorization_endpoint: 'https://attacker.invalid/authorize', token_endpoint: 'https://graph.facebook.com/v26.0/oauth/access_token', registration_endpoint: 'https://mcp.meta-ads.com/register' }))
    await f.manager.begin(); expect(f.manager.getSnapshot().status).toBe('failed'); expect(f.opened()).toBe('')
  })
  it('retains a grant but marks the connection degraded when read tools are unavailable', async () => {
    const f = fixture(async () => false); await f.manager.begin()
    const auth = new URL(f.opened()); await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.manager.getSnapshot().status === 'degraded')
    expect(f.saved()?.accessToken).toBe('synthetic-access')
    expect(f.manager.getSnapshot().connected).toBe(false)
    f.manager.cancel(); expect(f.manager.getSnapshot().status).toBe('degraded')
  })
})

describe('Pipeboard public client and endpoint boundaries', () => {
  it('registers only a public read client and opens the provider browser flow', async () => {
    const f = fixture()
    await f.manager.begin()
    const auth = new URL(f.opened())
    expect(auth.origin).toBe('https://pipeboard.co')
    expect(auth.pathname).toBe('/oauth/authorize')
    expect(auth.searchParams.get('platform')).toBe('meta-ads')
    expect(auth.searchParams.get('client_id')).toBe('synthetic-pipeboard-client')
    expect(auth.searchParams.get('scope')).toBe('mcp:read')
    expect(auth.searchParams.get('resource')).toBe(META_ADS_RESOURCE)
    const registration = JSON.parse(String(f.fetchImpl.mock.calls.find(([url]) => url === META_ADS_REGISTER)![1]?.body))
    expect(registration.redirect_uris).toEqual([auth.searchParams.get('redirect_uri')])
    expect(new URL(registration.redirect_uris[0]).hostname).toBe('127.0.0.1')
    expect(registration.token_endpoint_auth_method).toBe('none')
    await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.manager.getSnapshot().connected)
    expect(f.saved()?.clientId).toBe('synthetic-pipeboard-client')
    await f.manager.disconnect()
  })
  it('does not open a flow when client registration is rejected', async () => {
    const f = fixture(); const original = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (url, init) => url === META_ADS_REGISTER ? new Response('private error', { status: 400 }) : original(url, init))
    await f.manager.begin()
    expect(f.manager.getSnapshot()).toMatchObject({ status: 'failed', connected: false })
    expect(f.opened()).toBe('')
    expect(JSON.stringify(f.manager.getSnapshot())).not.toContain('private error')
  })
  it('rejects a token response that expands the grant to write access', async () => {
    const f = fixture(); const original = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (url, init) => url === META_ADS_TOKEN ? json({ access_token: 'private-token', scope: 'mcp:read mcp:write' }) : original(url, init))
    await f.manager.begin()
    await callback(f.opened(), new URL(f.opened()).searchParams.get('state')!)
    await flush(() => f.manager.getSnapshot().status === 'failed')
    expect(f.store.save).not.toHaveBeenCalled()
    expect(JSON.stringify(f.manager.getSnapshot())).not.toContain('private-token')
  })
  it('rejects discovery that would send grants to an untrusted token endpoint', async () => {
    const f = fixture()
    const original = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (url, init) => {
      const result = await original(url, init)
      if (url === META_ADS_AUTH_METADATA) return json({ ...await result.json(), token_endpoint: 'https://example.invalid/token' })
      return result
    })
    await f.manager.begin()
    expect(f.manager.getSnapshot().status).toBe('failed')
    expect(f.opened()).toBe('')
    expect(f.fetchImpl.mock.calls.some(([url]) => url.includes('example.invalid'))).toBe(false)
  })
})
