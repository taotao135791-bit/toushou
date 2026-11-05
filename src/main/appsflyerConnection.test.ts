import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const f = vi.hoisted(() => ({ data: '', agent: '', callback: undefined as undefined | ((v: unknown) => void), initializeCount: 0, facadeFailures: 0, closeCount: 0, state: 'disconnected', open: undefined as undefined | ((url: string) => Promise<void>), windows: [] as Array<{ close: ReturnType<typeof vi.fn>; ready: Promise<void>; done: Promise<'closed'> }>, tokenRead: vi.fn(async (): Promise<string | null> => 'synthetic-fresh') }))
const authorizationUrl = 'https://mcp.appsflyer.com/authorize?state=synthetic-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback'
vi.mock('electron', () => ({ app: { getPath: () => f.data }, BrowserWindow: { getAllWindows: () => [] }, session: {} }))
vi.mock('./piSettings', () => ({ defaultPiAgentDir: () => f.agent }))
vi.mock('./integrations/appsflyer/AppsFlyerConnectionManager', () => ({ AppsFlyerConnectionManager: class {
  constructor(options: { onChange: (v: unknown) => void; openExternal?: (url: string) => Promise<void> }) { f.callback = options.onChange; f.open = options.openExternal }
  async initialize() { f.initializeCount++ }
  hasVerifiedTools() { return true }
  getSnapshot() { return { ...snapshot(f.state), ...(f.state === 'waiting_for_user' ? { authorizationUrl } : {}) } }
  async begin() { f.state = 'waiting_for_user'; f.callback?.(this.getSnapshot()); await f.open?.(authorizationUrl); return this.getSnapshot() }
  cancel() { f.state = 'disconnected'; f.callback?.(snapshot('disconnected')); return {} }
  async disconnect() { f.state = 'disconnected'; f.callback?.(snapshot('disconnected')); return {} }
  async openAuthorizationUrl(url: string) { if (f.state !== 'waiting_for_user' || url !== authorizationUrl) return false; await f.open?.(url); return true }
  async getVerifiedAccessToken() { return f.tokenRead() }
} }))
vi.mock('./integrations/appsflyer/authWindow', () => ({ openAuthWindow: vi.fn(() => {
  let finish!: (value: 'closed') => void
  const handle = { ready: Promise.resolve(), done: new Promise<'closed'>(resolve => { finish = resolve }), close: vi.fn(() => finish('closed')) }
  f.windows.push(handle)
  return handle
}) }))
vi.mock('./integrations/appsflyer/AppsFlyerReadFacade', () => ({ AppsFlyerReadFacade: class {
  async initialize() { if (f.facadeFailures > 0) { f.facadeFailures--; throw new Error('private upstream error') }; return { endpoint: 'http://127.0.0.1:12345/mcp', token: 'synthetic-capability' } }
  close() { f.closeCount++ }
} }))
function snapshot(status: string) { return { definition: { id: 'appsflyer', kind: 'oauth', label: 'AppsFlyer', description: '', capabilities: [] }, status, connected: status === 'connected' } }
let root = ''
beforeEach(() => { vi.resetModules(); root = mkdtempSync(path.join(tmpdir(), 'toushou-af-test-')); f.data = path.join(root, 'data'); f.agent = path.join(root, 'agent'); mkdirSync(f.data); mkdirSync(f.agent); f.callback = undefined; f.initializeCount = 0; f.facadeFailures = 0; f.closeCount = 0; f.state = 'disconnected'; f.open = undefined; f.windows = []; f.tokenRead.mockReset().mockResolvedValue('synthetic-fresh') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
async function mod() { return import('./appsflyerConnection') }
describe('AppsFlyer application integration', () => {
  it('uses the same in-app opener for first connection and current-URL reopen, then closes on cancel/disconnect', async () => {
    const m = await mod()
    await m.beginAppsFlyerConnection()
    expect(f.windows).toHaveLength(1)
    expect(await m.openAppsFlyerAuthorizationUrl('https://example.invalid/')).toBe(false)
    expect(f.windows).toHaveLength(1)
    expect(await m.openAppsFlyerAuthorizationUrl(authorizationUrl)).toBe(true)
    expect(f.windows[0].close).toHaveBeenCalledOnce()
    await m.cancelAppsFlyerConnection()
    expect(f.windows[1].close).toHaveBeenCalledOnce()
    await m.beginAppsFlyerConnection()
    await m.disconnectAppsFlyerConnection()
    expect(f.windows[2].close).toHaveBeenCalledOnce()
    await m.shutdownAppsFlyerConnection()
  })
  it('does not release an awaited Main token after disconnect changes the projected connection', async () => {
    const m = await mod(); await m.initializeAppsFlyerConnection(); f.callback?.(snapshot('connected'))
    let release!: (value: string) => void
    f.tokenRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const reading = m.verifiedAppsFlyerAccessToken()
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve()
    await m.disconnectAppsFlyerConnection()
    release('synthetic-late-token')
    expect(await reading).toBeNull()
    expect(await m.verifiedAppsFlyerAccessToken()).toBeNull()
    await m.shutdownAppsFlyerConnection()
  })
  it('registers only local capability with private file mode and cleans up on exit', async () => {
    const m = await mod(); await m.initializeAppsFlyerConnection(); expect(m.appsFlyerToolEnv()).toEqual({}); f.callback?.(snapshot('connected'))
    const file = path.join(f.agent, 'mcp.json'); const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config.mcpServers.appsflyer.url).toBe('http://127.0.0.1:12345/mcp')
    expect(config.mcpServers.appsflyer.headers.Authorization).toBe('Bearer synthetic-capability')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await m.getAppsFlyerConnectionSnapshot())).not.toContain('synthetic-capability')
    expect(JSON.parse(m.appsFlyerToolEnv().TOUSHOU_APPSFLYER)).toEqual({ url: 'http://127.0.0.1:12345/mcp', token: 'synthetic-capability' })
    expect(readFileSync(path.join(f.data, 'skills', 'toushou-appsflyer.md'), 'utf8')).toContain('get_apps')
    await m.shutdownAppsFlyerConnection(); expect(m.appsFlyerToolEnv()).toEqual({}); expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.appsflyer).toBeUndefined(); expect(f.closeCount).toBe(1)
  })
  it('preserves handwritten or another integration’s same-name config', async () => {
    const file = path.join(f.agent, 'mcp.json'); const original = JSON.stringify({ mcpServers: { appsflyer: { type: 'http', url: 'https://example.invalid/mcp' } } }); writeFileSync(file, original)
    const m = await mod(); await m.initializeAppsFlyerConnection(); f.callback?.(snapshot('connected'))
    expect((await m.getAppsFlyerConnectionSnapshot()).status).toBe('degraded'); expect(m.appsFlyerToolEnv()).toEqual({}); expect(readFileSync(file, 'utf8')).toBe(original)
    await m.shutdownAppsFlyerConnection(); expect(readFileSync(file, 'utf8')).toBe(original)
  })
  it('does not overwrite a corrupted configuration or a changed owned entry', async () => {
    const file = path.join(f.agent, 'mcp.json'); writeFileSync(file, '{invalid')
    const m = await mod(); await m.initializeAppsFlyerConnection(); f.callback?.(snapshot('connected'))
    expect((await m.getAppsFlyerConnectionSnapshot()).status).toBe('degraded'); expect(readFileSync(file, 'utf8')).toBe('{invalid')
    await m.shutdownAppsFlyerConnection()
  })
  it('retries failed initialization only after explicit begin', async () => {
    f.facadeFailures = 1; const m = await mod(); await m.initializeAppsFlyerConnection(); expect((await m.getAppsFlyerConnectionSnapshot()).status).toBe('degraded'); expect(f.initializeCount).toBe(0)
    await m.beginAppsFlyerConnection(); expect(f.initializeCount).toBe(1); await m.shutdownAppsFlyerConnection()
  })
  it('preserves a connection changed after registration when shutting down', async () => {
    const m = await mod(); await m.initializeAppsFlyerConnection(); f.callback?.(snapshot('connected'))
    const file = path.join(f.agent, 'mcp.json'); const changed = JSON.parse(readFileSync(file, 'utf8')); changed.mcpServers.appsflyer.url = 'https://example.invalid/other'; writeFileSync(file, JSON.stringify(changed))
    await m.shutdownAppsFlyerConnection(); expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.appsflyer.url).toBe('https://example.invalid/other')
  })
})
