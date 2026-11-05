import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const f = vi.hoisted(() => ({ data: '', agent: '', callback: undefined as undefined | ((v: unknown) => void), initializeCount: 0, facadeFailures: 0, closeCount: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => f.data }, BrowserWindow: { getAllWindows: () => [] }, session: {} }))
vi.mock('./piSettings', () => ({ defaultPiAgentDir: () => f.agent }))
vi.mock('./integrations/meta/MetaAdsConnectionManager', () => ({ MetaAdsConnectionManager: class {
  constructor(options: { onChange: (v: unknown) => void }) { f.callback = options.onChange }
  async initialize() { f.initializeCount++ }
  hasVerifiedTools() { return true }
  async begin() { return {} }
  cancel() { return {} }
  async disconnect() { f.callback?.(snapshot('disconnected')); return {} }
  async openAuthorizationUrl() { return true }
} }))
vi.mock('./integrations/meta/MetaAdsReadFacade', () => ({ MetaAdsReadFacade: class {
  async initialize() { if (f.facadeFailures > 0) { f.facadeFailures--; throw new Error('private upstream error') }; return { endpoint: 'http://127.0.0.1:12345/mcp', token: 'synthetic-capability' } }
  close() { f.closeCount++ }
} }))
function snapshot(status: 'connected' | 'disconnected') { return { definition: { id: 'meta-ads', kind: 'oauth', label: 'MetaAds', description: '', capabilities: [] }, status, connected: status === 'connected' } }
let root = ''
beforeEach(() => { vi.resetModules(); root = mkdtempSync(path.join(tmpdir(), 'toushou-meta-test-')); f.data = path.join(root, 'data'); f.agent = path.join(root, 'agent'); mkdirSync(f.data); mkdirSync(f.agent); f.callback = undefined; f.initializeCount = 0; f.facadeFailures = 0; f.closeCount = 0 })
afterEach(() => rmSync(root, { recursive: true, force: true }))
async function mod() { return import('./metaConnection') }
describe('MetaAds application integration', () => {
  it('registers only local capability with private file mode and cleans up on exit', async () => {
    const m = await mod(); await m.initializeMetaAdsConnection(); f.callback?.(snapshot('connected'))
    const file = path.join(f.agent, 'mcp.json'); const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config.mcpServers['meta-ads'].url).toBe('http://127.0.0.1:12345/mcp')
    expect(config.mcpServers['meta-ads'].headers.Authorization).toBe('Bearer synthetic-capability')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await m.getMetaAdsConnectionSnapshot())).not.toContain('synthetic-capability')
    expect(readFileSync(path.join(f.data, 'skills', 'toushou-meta-ads.md'), 'utf8')).toContain('get_ad_accounts')
    await m.shutdownMetaAdsConnection(); expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['meta-ads']).toBeUndefined(); expect(f.closeCount).toBe(1)
  })
  it('preserves handwritten or another integration’s same-name config', async () => {
    const file = path.join(f.agent, 'mcp.json'); const original = JSON.stringify({ mcpServers: { 'meta-ads': { type: 'http', url: 'https://example.invalid/mcp' } } }); writeFileSync(file, original)
    const m = await mod(); await m.initializeMetaAdsConnection(); f.callback?.(snapshot('connected'))
    expect((await m.getMetaAdsConnectionSnapshot()).status).toBe('degraded'); expect(readFileSync(file, 'utf8')).toBe(original)
    await m.shutdownMetaAdsConnection(); expect(readFileSync(file, 'utf8')).toBe(original)
  })
  it('does not overwrite a corrupted configuration or a changed owned entry', async () => {
    const file = path.join(f.agent, 'mcp.json'); writeFileSync(file, '{invalid')
    const m = await mod(); await m.initializeMetaAdsConnection(); f.callback?.(snapshot('connected'))
    expect((await m.getMetaAdsConnectionSnapshot()).status).toBe('degraded'); expect(readFileSync(file, 'utf8')).toBe('{invalid')
    await m.shutdownMetaAdsConnection()
  })
  it('retries failed initialization only after explicit begin', async () => {
    f.facadeFailures = 1; const m = await mod(); await m.initializeMetaAdsConnection(); expect((await m.getMetaAdsConnectionSnapshot()).status).toBe('degraded'); expect(f.initializeCount).toBe(0)
    await m.beginMetaAdsConnection(); expect(f.initializeCount).toBe(1); await m.shutdownMetaAdsConnection()
  })
  it('preserves a connection changed after registration when shutting down', async () => {
    const m = await mod(); await m.initializeMetaAdsConnection(); f.callback?.(snapshot('connected'))
    const file = path.join(f.agent, 'mcp.json'); const changed = JSON.parse(readFileSync(file, 'utf8')); changed.mcpServers['meta-ads'].url = 'https://example.invalid/other'; writeFileSync(file, JSON.stringify(changed))
    await m.shutdownMetaAdsConnection(); expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['meta-ads'].url).toBe('https://example.invalid/other')
  })
})
