import { describe, expect, it, vi } from 'vitest'
import type { TikTokStoredCredentials } from '../tiktok/TikTokCredentialStore'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/synthetic-appsflyer-test' }, shell: { openExternal: vi.fn() }, session: { fromPartition: vi.fn() }, safeStorage: {} }))
import { AppsFlyerConnectionManager } from './AppsFlyerConnectionManager'
import { TikTokCredentialStorageError } from '../tiktok/tiktokCredentialStorageError'
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
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) return json({ authorization_endpoint: 'https://mcp.appsflyer.com/authorize', token_endpoint: 'https://mcp.appsflyer.com/token', registration_endpoint: 'https://mcp.appsflyer.com/register' })
    if (url.endsWith('/register')) { expect(JSON.parse(String(init?.body)).token_endpoint_auth_method).toBe('client_secret_post'); return json({ client_id: 'synthetic-client', client_secret: 'synthetic-secret' }) }
    if (url.endsWith('/token')) return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
    throw new Error('unexpected')
  })
  const manager = new AppsFlyerConnectionManager({ credentialStore: store, fetchImpl, now, probe: async token => await probe(token) ? [{ name: 'get_apps', inputSchema: { type: 'object' } }, { name: 'analytics_fetch_aggregated_data', inputSchema: { type: 'object' } }] : [], openExternal: async url => { opened = url } })
  return { manager, store, fetchImpl, opened: () => opened, saved: () => saved, block: () => { blockSave = true }, release: () => release?.() }
}
async function callback(url: string, state: string, code = 'synthetic-code') { const origin = new URL(new URL(url).searchParams.get('redirect_uri')!).origin; return fetch(`${origin}/callback?state=${encodeURIComponent(state)}&code=${code}`) }
describe('AppsFlyer OAuth', () => {
  it('uses PKCE, ignores unrelated callbacks, and stores a successful grant', async () => {
    const f = fixture(); await f.manager.initialize(); await f.manager.begin()
    const auth = new URL(f.opened()); expect(auth.searchParams.get('scope')).toBe('user'); expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect((await callback(f.opened(), 'wrong')).status).toBe(400)
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    expect((await callback(f.opened(), auth.searchParams.get('state')!)).status).toBe(200)
    await flush(() => f.manager.getSnapshot().connected)
    expect(await f.manager.loadFreshCredentials()).toEqual({ accessToken: 'synthetic-access' })
    expect(JSON.stringify(f.manager.getSnapshot())).not.toContain('synthetic-secret')
    expect(f.store.save).toHaveBeenCalledTimes(1)
    await f.manager.disconnect(); expect(f.saved()).toBeNull()
  })
  it('uses the verified cached schema until refresh or an authorization failure', async () => {
    let clock = 1_000; const probe = vi.fn(async () => true); const f = fixture(probe, () => clock)
    await f.manager.begin(); const auth = new URL(f.opened()); await callback(f.opened(), auth.searchParams.get('state')!)
    await flush(() => f.manager.getSnapshot().connected)
    const schema = await f.manager.getVerifiedToolDescriptions(); expect(schema).toHaveLength(2)
    schema![0].name = 'mutated'
    expect((await f.manager.getVerifiedToolDescriptions())?.[0].name).toBe('get_apps')
    expect(probe).toHaveBeenCalledTimes(1)
    clock += 3_600_000
    const fresh = await Promise.all([f.manager.getVerifiedToolDescriptions(), f.manager.getVerifiedToolDescriptions()])
    expect(fresh[0]).toHaveLength(2); expect(probe).toHaveBeenCalledTimes(2)
    f.manager.markReadFailure(new Error('appsflyer-authorization-error'), 'synthetic-access')
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
    f.manager.markReadFailure(new Error('appsflyer-authorization-error'), 'synthetic-old')
    expect(f.manager.getSnapshot().connected).toBe(true)
    let unblock!: () => void
    f.store.clear.mockImplementationOnce(async () => { await new Promise<void>(resolve => { unblock = resolve }) })
    const disconnect = f.manager.disconnect(); await flush(() => typeof unblock === 'function')
    expect(await f.manager.loadFreshCredentials()).toBeNull()
    f.manager.markReadFailure(new Error('appsflyer-authorization-error'), 'synthetic-new')
    unblock(); await disconnect
    f.manager.markReadFailure(new Error('appsflyer-authorization-error'), 'synthetic-new')
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
    const f = fixture(); f.fetchImpl.mockImplementation(async () => json({ authorization_endpoint: 'https://attacker.invalid/authorize', token_endpoint: 'https://mcp.appsflyer.com/token', registration_endpoint: 'https://mcp.appsflyer.com/register' }))
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
