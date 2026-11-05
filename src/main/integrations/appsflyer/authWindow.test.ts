import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ windows: [] as any[], setProxy: vi.fn(async () => {}), permissions: vi.fn(), checks: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    loadURL = vi.fn(async () => {})
    show = vi.fn()
    destroyed = false
    options: unknown
    constructor(options: unknown) { super(); this.options = options; fixture.windows.push(this) }
    isDestroyed() { return this.destroyed }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  }
  return { BrowserWindow: Window, session: { fromPartition: () => ({ setProxy: fixture.setProxy, setPermissionRequestHandler: fixture.permissions, setPermissionCheckHandler: fixture.checks }) } }
})
import { openAuthWindow, type AuthWindowHandle } from './authWindow'
import { AppsFlyerConnectionManager } from './AppsFlyerConnectionManager'

let server: Server | undefined
let handle: AuthWindowHandle | undefined
const authUrl = (callback: string) => `https://mcp.appsflyer.com/authorize?state=synthetic-state&redirect_uri=${encodeURIComponent(callback)}`
const flush = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true) }
async function listen(onRequest: RequestListener): Promise<string> {
  server = createServer(onRequest)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic listener unavailable')
  return `http://127.0.0.1:${address.port}/callback`
}
beforeEach(() => { fixture.windows.length = 0; fixture.setProxy.mockReset().mockResolvedValue(undefined) })
afterEach(async () => {
  handle?.close(); handle = undefined
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
})

describe('AppsFlyer isolated authorization window', () => {
  it('completes the real Main callback and PKCE exchange with a synthetic provider', async () => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    const saved = vi.fn(async (_value: unknown, options?: { beforeCommit?: () => boolean; onCommitted?: () => void }) => { if (options?.beforeCommit?.() === false) throw new Error('Synthetic cancelled'); options?.onCommitted?.() })
    const tokenRequest = vi.fn()
    const manager = new AppsFlyerConnectionManager({
      credentialStore: { load: async () => null, retry: async () => null, clear: async () => {}, sharedStorageBlockedEpoch: () => null, save: saved },
      fetchImpl: async (url, init) => {
        if (url.endsWith('oauth-authorization-server')) return json({ authorization_endpoint: 'https://mcp.appsflyer.com/authorize', token_endpoint: 'https://mcp.appsflyer.com/token', registration_endpoint: 'https://mcp.appsflyer.com/register' })
        if (url.endsWith('/register')) return json({ client_id: 'synthetic-client', client_secret: 'synthetic-secret' })
        tokenRequest(new URLSearchParams(String(init?.body)))
        return json({ access_token: 'synthetic-access', expires_in: 3600 })
      },
      probe: async () => [{ name: 'get_apps', inputSchema: {} }, { name: 'analytics_fetch_aggregated_data', inputSchema: {} }],
      openExternal: async url => { handle = openAuthWindow(url, new URL(url).searchParams.get('redirect_uri')!); await handle.ready }
    })
    try {
      const waiting = await manager.begin()
      const authorization = new URL(waiting.authorizationUrl!)
      const target = new URL(authorization.searchParams.get('redirect_uri')!)
      target.searchParams.set('state', authorization.searchParams.get('state')!)
      target.searchParams.set('code', 'synthetic-code')
      fixture.windows[0].webContents.emit('will-redirect', { preventDefault() {} }, target.href)
      await flush(() => manager.getSnapshot().connected)
      expect(saved).toHaveBeenCalledOnce()
      expect(tokenRequest.mock.calls[0][0].get('code')).toBe('synthetic-code')
      expect(tokenRequest.mock.calls[0][0].get('code_verifier')).toHaveLength(43)
      expect(await manager.getVerifiedAccessToken()).toBe('synthetic-access')
    } finally { await manager.disconnect() }
  })
  it('delivers the exact callback over loopback before closing and sends no browser credentials', async () => {
    const requests: Array<{ path?: string; cookie?: string; authorization?: string }> = []
    const callback = await listen((request, response) => { requests.push({ path: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization }); response.end('Synthetic accepted') })
    handle = openAuthWindow(authUrl(callback), callback)
    await handle.ready
    const event = { preventDefault: vi.fn() }
    fixture.windows[0].webContents.emit('will-redirect', event, `${callback}?state=synthetic-state&code=synthetic-code`)
    expect(await handle.done).toBe('redirected')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(requests).toEqual([{ path: '/callback?state=synthetic-state&code=synthetic-code', cookie: undefined, authorization: undefined }])
    expect(fixture.windows[0].destroyed).toBe(true)
    expect(fixture.windows[0].options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  })

  it('blocks callback lookalikes and other non-HTTPS redirects', async () => {
    let requests = 0
    const callback = await listen((_request, response) => { requests++; response.end() })
    handle = openAuthWindow(authUrl(callback), callback)
    await handle.ready
    for (const target of [`${callback}-other?state=synthetic-state`, callback.replace('/callback', '/other'), 'http://example.invalid/', 'file:///tmp/synthetic', callback.replace('127.0.0.1', 'localhost')]) {
      const event = { preventDefault: vi.fn() }
      fixture.windows[0].webContents.emit('will-redirect', event, target)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(requests).toBe(0)
    expect(fixture.windows[0].destroyed).toBe(false)
  })

  it('leaves invalid state to the listener and can accept a subsequent valid callback', async () => {
    let requests = 0
    const callback = await listen((request, response) => { requests++; response.statusCode = request.url?.includes('state=synthetic-state') ? 200 : 400; response.end() })
    handle = openAuthWindow(authUrl(callback), callback)
    await handle.ready
    fixture.windows[0].webContents.emit('will-navigate', { preventDefault() {} }, `${callback}?state=wrong&code=synthetic-code`)
    await flush(() => requests === 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fixture.windows[0].destroyed).toBe(false)
    fixture.windows[0].webContents.emit('will-redirect', { preventDefault() {} }, `${callback}?state=synthetic-state&code=synthetic-code`)
    expect(await handle.done).toBe('redirected')
    expect(requests).toBe(2)
  })

  it('cannot forward any callback after cancellation', async () => {
    let requests = 0
    const callback = await listen((_request, response) => { requests++; response.end() })
    handle = openAuthWindow(authUrl(callback), callback)
    await handle.ready
    handle.close()
    fixture.windows[0].webContents.emit('will-redirect', { preventDefault() {} }, `${callback}?state=synthetic-state&code=synthetic-code`)
    expect(await handle.done).toBe('closed')
    expect(requests).toBe(0)
  })

  it('rejects arbitrary initial URLs or mismatched loopback targets', () => {
    const callback = 'http://127.0.0.1:43210/callback'
    for (const [url, target] of [[authUrl(callback).replace('mcp.appsflyer.com', 'example.invalid'), callback], [authUrl(callback), callback.replace('43210', '43211')], [authUrl(callback), 'http://localhost:43210/callback'], [authUrl(callback), `${callback}?extra=1`]]) {
      expect(() => openAuthWindow(url, target)).toThrow()
    }
    expect(fixture.windows).toHaveLength(0)
  })

  it('waits for proxy setup, handles load failures, and denies page permission requests', async () => {
    let release!: () => void
    fixture.setProxy.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const callback = 'http://127.0.0.1:43210/callback'
    handle = openAuthWindow(authUrl(callback), callback)
    const window = fixture.windows[0]
    expect(window.loadURL).not.toHaveBeenCalled()
    window.loadURL.mockRejectedValueOnce(new Error('Synthetic load failure'))
    release()
    await expect(handle.ready).rejects.toThrow()
    expect(await handle.done).toBe('closed')
    const reply = vi.fn()
    fixture.permissions.mock.calls.at(-1)![0](null, 'camera', reply)
    expect(reply).toHaveBeenCalledWith(false)
    expect(fixture.checks.mock.calls.at(-1)![0]()).toBe(false)
  })
})
