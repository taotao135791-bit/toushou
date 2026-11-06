import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: {}, session: {}, safeStorage: {} }))
const calls = vi.hoisted(() => ({ init: vi.fn(async () => {}), raw: vi.fn(async () => ({ content: [{ type: 'text', text: 'synthetic report' }], structuredContent: { data: [{ id: 'synthetic-account' }] } })), apps: vi.fn(async () => [{ appId: 'demo', name: 'Demo', platform: null }]) }))
vi.mock('./MetaAdsMcpClient', () => ({ MetaAdsMcpClient: class { initialize = calls.init; listApps = calls.apps; callReadTool = calls.raw } }))
import { MetaAdsReadFacade } from './MetaAdsReadFacade'
import type { MetaAdsConnectionManager } from './MetaAdsConnectionManager'
let facade: MetaAdsReadFacade | undefined
afterEach(() => { facade?.close(); facade = undefined; calls.init.mockClear(); calls.raw.mockClear(); calls.apps.mockClear() })
describe('MetaAds local read-only MCP facade', () => {
  it('releases closed or idle sessions without exhausting the local session cap', async () => {
    let now = 0
    facade = new MetaAdsReadFacade({} as MetaAdsConnectionManager, () => now)
    const { endpoint, token } = await facade.initialize()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const initialize = () => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    const sessions = await Promise.all(Array.from({ length: 100 }, () => initialize()))
    expect(sessions.every(response => response.status === 200)).toBe(true)
    expect((await initialize()).status).toBe(400)
    const session = sessions[0].headers.get('mcp-session-id')!
    expect((await fetch(endpoint, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } })).status).toBe(204)
    expect((await initialize()).status).toBe(200)
    now = 3_600_001
    expect((await initialize()).status).toBe(200)
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessions[1].headers.get('mcp-session-id')! }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) })).status).toBe(400)
  })
  it('requires capability and session, exposes only read tools and rejects writes', async () => {
    facade = new MetaAdsReadFacade({ loadFreshCredentials: async () => ({ accessToken: 'synthetic' }), getVerifiedToolDescriptions: async () => [{ name: 'get_ad_accounts', inputSchema: { type: 'object' } }, { name: 'get_insights', inputSchema: { type: 'object' } }], markReadFailure: () => {} } as unknown as MetaAdsConnectionManager)
    const { endpoint, token } = await facade.initialize()
    const post = (body: unknown, session?: string, authorization = `Bearer ${token}`) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) })
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, 'Bearer wrong')).status).toBe(403)
    const initial = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); const session = initial.headers.get('mcp-session-id')!
    expect(session).toBeTruthy()
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session)
    const listed = await list.json() as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.map(t => t.name)).toEqual(['get_ad_accounts', 'get_insights'])
    expect(calls.init).not.toHaveBeenCalled()
    const rejected = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_campaign', arguments: {} } }, session)
    expect((await rejected.json() as { result: { isError: boolean } }).result.isError).toBe(true)
    expect(calls.raw).not.toHaveBeenCalled()
    const read = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_ad_accounts', arguments: {} } }, session)
    expect((await read.json() as { result: { structuredContent: { data: unknown[] } } }).result.structuredContent.data).toHaveLength(1)
    const implicitArgs = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_ad_accounts' } }, session)
    expect((await implicitArgs.json() as { result: { structuredContent: { data: unknown[] } } }).result.structuredContent.data).toHaveLength(1)
    const missingQuery = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_insights' } }, session)
    expect((await missingQuery.json() as { error: { message: string } }).error.message).toBe('Invalid request')
    expect((await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'wrong-session')).status).toBe(400)
  })
})
