import { afterEach, describe, expect, it, vi } from 'vitest'
import register, { queryArguments } from '../../../resources/appsflyer-toolkit/extensions/index'

type Tool = { name: string; approval: string; execute: (id: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
const tools = () => { const items: Tool[] = []; register({ registerTool: tool => items.push(tool as Tool) }); return items }
const fixture = { appId: 'example.app', startDate: '2026-10-01', endDate: '2026-10-02' }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('AppsFlyer bundled read-only tools', () => {
  it('constructs bounded queries and discovers events without fabricating dimensions', () => {
    const event = queryArguments({ ...fixture, eventName: 'example_event', basis: 'ltv', rowCount: 300 }) as { query: Record<string, unknown> }
    expect(event.query).toMatchObject({ app_ids: ['example.app'], row_count: 300, in_app_event: ['example_event'], groupings: ['Campaign ID', 'Campaign', 'Media source', 'Date'], filters: { 'Media source': ['tiktokglobal_int'] }, sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }], metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: 'ltv' }, { metric_name: 'Unique users', attribution_source: 'appsflyer', period: 'ltv' }] })
    const discovery = queryArguments(fixture) as { query: Record<string, unknown> }
    expect(discovery.query).toMatchObject({ in_app_event: [], groupings: ['Event name', 'Media source', 'Date', 'Campaign ID'] })
    for (const args of [{ ...fixture, rowCount: 301 }, { ...fixture, startDate: '2026-02-30' }, { ...fixture, appId: '' }, { ...fixture, eventName: 'x\n' }, { ...fixture, basis: 'invalid' }, { ...fixture, unknown: 1 }]) expect(queryArguments(args)).toBeNull()
  })

  it('registers only read tools and uses a local capability for bounded MCP calls and cleanup', async () => {
    const secret = 'a'.repeat(43)
    vi.stubEnv('TOUSHOU_APPSFLYER', JSON.stringify({ url: 'http://127.0.0.1:9999/mcp', token: secret }))
    const requests: Array<{ method: string; payload?: Record<string, unknown>; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      if (init.method === 'DELETE') { requests.push({ method: 'DELETE', headers }); return new Response(null, { status: 204 }) }
      const payload = JSON.parse(init.body as string) as Record<string, unknown>
      requests.push({ method: String(payload.method), payload, headers })
      if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { structuredContent: { data: { rows: [{ event: 'example_event', count: 3 }], timezone: 'UTC' } } } }), { status: 200, headers: payload.method === 'initialize' ? { 'mcp-session-id': 'session_1' } : {} })
    }))
    const registered = tools()
    expect(registered.map(t => [t.name, t.approval])).toEqual([['toushou_appsflyer_apps', 'read'], ['toushou_appsflyer_query', 'read']])
    const response = await registered[1].execute('x', { ...fixture, eventName: 'example_event' })
    expect(JSON.parse(response.content[0].text)).toMatchObject({ ok: true, source: 'AppsFlyer', data: { timezone: 'UTC' } })
    expect(requests.map(r => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'DELETE'])
    expect(requests[2].payload?.params).toMatchObject({ name: 'analytics_fetch_aggregated_data', arguments: queryArguments({ ...fixture, eventName: 'example_event' }) })
    expect(requests.every(r => r.headers.authorization === `Bearer ${secret}`)).toBe(true)
    expect(response.content[0].text).not.toContain(secret)
  })

  it('rejects non-loopback configuration and never leaks provider bodies or capability on errors', async () => {
    const secret = 'b'.repeat(43)
    const fetchMock = vi.fn(async () => new Response(`bad response ${secret}`, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TOUSHOU_APPSFLYER', JSON.stringify({ url: 'https://example.test/mcp', token: secret }))
    let result = await tools()[0].execute('x', {})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.content[0].text).not.toContain(secret)
    vi.stubEnv('TOUSHOU_APPSFLYER', JSON.stringify({ url: 'http://127.0.0.1:9999/mcp', token: secret }))
    result = await tools()[0].execute('x', {})
    expect(JSON.parse(result.content[0].text).ok).toBe(false)
    expect(result.content[0].text).not.toContain(secret)
    expect(result.content[0].text).not.toContain('9999')
    expect(result.content[0].text).not.toContain('bad response')
  })
})
