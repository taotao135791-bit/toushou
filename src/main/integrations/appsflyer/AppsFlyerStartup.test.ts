import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TikTokCredentialStorageError } from '../tiktok/tiktokCredentialStorageError'

const listener = vi.hoisted(() => ({ mode: 'normal' as 'normal' | 'error' | 'stalled', servers: [] as Array<{ close: ReturnType<typeof vi.fn>; trigger: () => void }> }))
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic' }, shell: { openExternal: vi.fn() }, session: { fromPartition: vi.fn() }, safeStorage: {} }))
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  const { EventEmitter } = await import('node:events')
  return { ...actual, createServer: () => {
    const server = new EventEmitter() as InstanceType<typeof EventEmitter> & { listen: (port: number, host: string, callback: () => void) => void; address: () => { port: number }; close: ReturnType<typeof vi.fn>; trigger: () => void }
    server.address = () => ({ port: 43123 })
    server.close = vi.fn()
    server.trigger = () => {}
    server.listen = (_port, _host, callback) => {
      server.trigger = callback
      if (listener.mode === 'normal') void Promise.resolve().then(callback)
      if (listener.mode === 'error') void Promise.resolve().then(() => server.emit('error', new Error('private-listener-detail')))
    }
    listener.servers.push(server)
    return server
  } }
})
import { AppsFlyerConnectionManager } from './AppsFlyerConnectionManager'

const metadata = { authorization_endpoint: 'https://mcp.appsflyer.com/authorize', token_endpoint: 'https://mcp.appsflyer.com/token', registration_endpoint: 'https://mcp.appsflyer.com/register' }
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(platform: NodeJS.Platform = 'win32') {
  const store = { load: vi.fn(async () => null), retry: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}), sharedStorageBlockedEpoch: () => null }
  const fetcher = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => url.endsWith('/register') ? json({ client_id: 'synthetic-client', client_secret: 'synthetic-secret' }) : json(metadata))
  const open = vi.fn(async (_url: string): Promise<void> => {})
  const onChange = vi.fn()
  const manager = new AppsFlyerConnectionManager({ credentialStore: store, fetchImpl: fetcher, openExternal: open, onChange, platform })
  return { manager, store, fetcher, open, onChange }
}
const privateDetail = 'synthetic-private-error-marker'
function assertSafeError(value: { lastError?: string }, label: RegExp) {
  expect(value.lastError).toMatch(label)
  expect(JSON.stringify(value.lastError)).not.toContain(privateDetail)
}

beforeEach(() => { listener.mode = 'normal'; listener.servers = [] })
afterEach(() => { vi.useRealTimers() })

describe('AppsFlyer startup: bounded failures and recovery', () => {
  it('reports a safe storage failure before network or browser actions', async () => {
    const f = fixture()
    f.store.load.mockRejectedValueOnce(new TikTokCredentialStorageError())
    const result = await f.manager.begin()
    expect(result.status).toBe('failed')
    assertSafeError(result, /存储|凭据/)
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })

  it('reports discovery errors without leaking provider details and can retry', async () => {
    const f = fixture()
    f.fetcher.mockRejectedValueOnce(new Error(privateDetail))
    const failure = await f.manager.begin()
    expect(failure.status).toBe('failed'); assertSafeError(failure, /服务发现/)
    expect(f.open).not.toHaveBeenCalled()
    const retried = await f.manager.begin()
    expect(retried.status).toBe('waiting_for_user'); expect(f.open).toHaveBeenCalledTimes(1)
    f.manager.cancel()
  })

  it('shows only the status code for provider HTTP failures, never the response body', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValueOnce(new Response(privateDetail, { status: 403 }))
    const result = await f.manager.begin()
    expect(result.status).toBe('failed'); assertSafeError(result, /AF-DISCOVERY/)
    expect(result.lastError).toContain('403')
    expect(f.open).not.toHaveBeenCalled()
  })

  it('bounds an uncooperative discovery request, allows retry, and ignores late rejection', async () => {
    vi.useFakeTimers()
    const f = fixture(), stalled = deferred<Response>()
    f.fetcher.mockImplementationOnce(() => stalled.promise)
    const pending = f.manager.begin()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(f.manager.getSnapshot().status).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    const failure = await pending
    expect(failure.status).toBe('failed'); assertSafeError(failure, /服务发现/)
    expect(failure.lastError).toContain('超时')
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(f.open).not.toHaveBeenCalled()
    const retry = await f.manager.begin()
    expect(retry.status).toBe('waiting_for_user')
    stalled.reject(new Error(privateDetail))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    f.manager.cancel()
  })

  it('bounds discovery response-body parsing as part of the same deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const body = deferred<unknown>()
    f.fetcher.mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response)
    const pending = f.manager.begin()
    await vi.advanceTimersByTimeAsync(20_000)
    const failure = await pending
    expect(failure.status).toBe('failed'); assertSafeError(failure, /服务发现/)
    expect(f.open).not.toHaveBeenCalled()
    body.resolve(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.manager.getSnapshot().status).toBe('failed')
  })

  it('reports and cleans up failed or stalled loopback listeners', async () => {
    const failed = fixture()
    listener.mode = 'error'
    const result = await failed.manager.begin()
    expect(result.status).toBe('failed'); assertSafeError(result, /本机回调/)
    expect(failed.open).not.toHaveBeenCalled()
    vi.useFakeTimers()
    listener.mode = 'stalled'
    const stalled = fixture(), pending = stalled.manager.begin()
    await vi.advanceTimersByTimeAsync(5_000)
    const timedOut = await pending
    expect(timedOut.status).toBe('failed'); assertSafeError(timedOut, /本机回调/)
    expect(stalled.open).not.toHaveBeenCalled()
    const server = listener.servers.at(-1)!
    const closesBeforeLateListen = server.close.mock.calls.length
    server.trigger()
    expect(server.close.mock.calls.length).toBeGreaterThan(closesBeforeLateListen)
  })

  it('closes the listener and hides provider details when registration fails', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValueOnce(json(metadata)).mockRejectedValueOnce(new Error(privateDetail))
    const result = await f.manager.begin()
    expect(result.status).toBe('failed'); assertSafeError(result, /授权注册/)
    expect(listener.servers[0].close).toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  })

  it('bounds registration and closes its listener before retry; late failure cannot replace the new flow', async () => {
    vi.useFakeTimers()
    const f = fixture(), registration = deferred<Response>()
    f.fetcher.mockResolvedValueOnce(json(metadata)).mockImplementationOnce(() => registration.promise)
    const pending = f.manager.begin()
    await vi.advanceTimersByTimeAsync(20_000)
    const failure = await pending
    expect(failure.status).toBe('failed'); assertSafeError(failure, /授权注册/)
    expect(listener.servers[0].close).toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
    const retry = await f.manager.begin()
    expect(retry.status).toBe('waiting_for_user')
    registration.reject(new Error(privateDetail))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    f.manager.cancel()
  })

  it('keeps a newer flow intact when a cancelled registration later rejects', async () => {
    const f = fixture(), registration = deferred<Response>()
    f.fetcher.mockResolvedValueOnce(json(metadata)).mockImplementationOnce(() => registration.promise)
    const old = f.manager.begin()
    for (let i = 0; i < 20 && f.fetcher.mock.calls.length < 2; i++) await Promise.resolve()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.manager.cancel().status).toBe('disconnected')
    const next = await f.manager.begin()
    expect(next.status).toBe('waiting_for_user')
    registration.reject(new Error(privateDetail))
    await old
    expect(listener.servers[0].close).toHaveBeenCalled()
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    expect(f.manager.getSnapshot().authorizationUrl).toBe(next.authorizationUrl)
    expect(f.manager.getSnapshot().lastError).toBeUndefined()
    f.manager.cancel()
  })

  it('bounds a stalled browser launch and only reopens the still-active authorization URL', async () => {
    vi.useFakeTimers()
    const f = fixture(), launch = deferred<void>()
    f.open.mockImplementationOnce(() => launch.promise)
    const pending = f.manager.begin()
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.status).toBe('waiting_for_user'); assertSafeError(result, /浏览器/)
    const url = result.authorizationUrl!
    expect(await f.manager.openAuthorizationUrl('https://invalid.example/')).toBe(false)
    expect(await f.manager.openAuthorizationUrl(url)).toBe(true)
    f.manager.cancel()
    expect(await f.manager.openAuthorizationUrl(url)).toBe(false)
    const next = await f.manager.begin()
    expect(next.status).toBe('waiting_for_user')
    expect(await f.manager.openAuthorizationUrl(url)).toBe(false)
    f.manager.cancel()
    launch.reject(new Error(privateDetail))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.manager.getSnapshot().status).toBe('disconnected')
    expect(f.manager.getSnapshot().lastError).toBeUndefined()
  })

  it('retains the authorization after a rejected browser launch and clears the error on reopen', async () => {
    const f = fixture()
    f.open.mockRejectedValueOnce(new Error(privateDetail))
    const failure = await f.manager.begin()
    expect(failure.status).toBe('waiting_for_user'); assertSafeError(failure, /AF-BROWSER/)
    expect(failure.authorizationUrl).toBeTruthy()
    expect(await f.manager.openAuthorizationUrl(failure.authorizationUrl!)).toBe(true)
    expect(f.manager.getSnapshot().lastError).toBeUndefined()
    f.manager.cancel()
  })

  it('never lets late discovery failure overwrite user cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture(), pendingFetch = deferred<Response>()
    f.fetcher.mockImplementationOnce(() => pendingFetch.promise)
    const pending = f.manager.begin()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.manager.cancel().status).toBe('disconnected')
    pendingFetch.reject(new Error(privateDetail))
    await pending
    expect(f.manager.getSnapshot().status).toBe('disconnected')
    expect(f.manager.getSnapshot().lastError).toBeUndefined()
    expect(f.open).not.toHaveBeenCalled()
  })
})


describe('AppsFlyer startup on macOS retains existing behavior', () => {
  it('keeps the original generic discovery failure and does not leak provider details', async () => {
    const f = fixture('darwin')
    f.fetcher.mockRejectedValueOnce(new Error(privateDetail))
    const result = await f.manager.begin()
    expect(result.status).toBe('failed')
    expect(result.lastError).toBe('连接初始化失败，请重试或检查安全存储')
    expect(result.lastError).not.toContain(privateDetail)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('keeps the original browser error after a successful manual reopen without another event', async () => {
    const f = fixture('darwin')
    f.open.mockRejectedValueOnce(new Error(privateDetail))
    const failure = await f.manager.begin()
    expect(failure.status).toBe('waiting_for_user')
    expect(failure.lastError).toBe('无法打开浏览器，请手动打开授权链接')
    const eventsBeforeReopen = f.onChange.mock.calls.length
    expect(await f.manager.openAuthorizationUrl(failure.authorizationUrl!)).toBe(true)
    expect(f.manager.getSnapshot().lastError).toBe(failure.lastError)
    expect(f.onChange).toHaveBeenCalledTimes(eventsBeforeReopen)
    f.manager.cancel()
  })

  it('does not impose the Windows 10-second browser deadline', async () => {
    vi.useFakeTimers()
    const f = fixture('darwin'), launch = deferred<void>()
    f.open.mockImplementationOnce(() => launch.promise)
    let done = false
    const pending = f.manager.begin().then(value => { done = true; return value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(done).toBe(false)
    expect(f.manager.getSnapshot().status).toBe('waiting_for_user')
    expect(f.manager.getSnapshot().lastError).toBeUndefined()
    launch.resolve()
    expect((await pending).status).toBe('waiting_for_user')
    f.manager.cancel()
  })
})
