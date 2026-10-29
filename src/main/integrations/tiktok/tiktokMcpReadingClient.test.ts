import { describe, expect, it } from 'vitest'
import { TikTokMcpReadingClient } from './tiktokMcpReadingClient'
import type { TikTokApiFetch } from './tiktokClient'

const ID = '7300000000000000001'
const names = ['auth_advertiser_get', 'advertiser_info_get', 'report_integrated_get']
function mockServer(options: { missing?: string; pages?: number; sse?: boolean; fail?: boolean; duplicate?: boolean; missingMetric?: boolean; wrongDate?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = []
  const fetchImpl: TikTokApiFetch = async (url, init) => {
    expect(url).toBe('https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer')
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> }
    calls.push({ method: request.method, params: request.params, headers: new Headers(init?.headers) })
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let result: unknown
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26' }
    else if (request.method === 'tools/list') result = { tools: names.filter((name) => name !== options.missing).map((name) => ({ name })) }
    else {
      const name = request.params.name
      const args = request.params.arguments as Record<string, unknown>
      if (options.fail && name === 'report_integrated_get') result = { isError: true, content: [{ type: 'text', text: 'failure' }] }
      else {
        const data = name === 'auth_advertiser_get' ? { list: [{ advertiser_id: ID }] } : name === 'advertiser_info_get' ? { list: [{ advertiser_id: ID, name: 'Account', currency: 'USD' }] } : { list: [{ dimensions: { campaign_id: options.duplicate ? '1' : String(args.page), stat_time_day: options.wrongDate ? '2020-01-01' : args.start_date }, metrics: { campaign_name: 'A', spend: '5', impressions: '100', clicks: '2', ...(options.missingMetric ? {} : { conversion: '1' }) } }], page_info: { total_page: options.pages ?? 1 } }
        result = { content: [{ type: 'text', text: JSON.stringify({ code: 0, data }) }] }
      }
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
    return options.sse ? new Response(`event: message\ndata: ${body}\n\n`, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session' } }) : new Response(body, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session' } })
  }
  return { fetchImpl, calls }
}

describe('application TikTok MCP reading client', () => {
  it('discovers and calls only read tools, sends bearer and session, handles SSE and paginated reports', async () => {
    const server = mockServer({ pages: 2, sse: true })
    const client = new TikTokMcpReadingClient('secret', server.fetchImpl)
    await client.initialize()
    expect(await client.advertisers()).toEqual([ID])
    expect(await client.info([ID])).toEqual([{ advertiserId: ID, name: 'Account', currency: 'USD' }])
    expect(await client.report(ID, '2026-09-01', '2026-09-07')).toHaveLength(2)
    expect(server.calls.every((c) => c.headers.get('authorization') === 'Bearer secret')).toBe(true)
    expect(server.calls.slice(1).every((c) => c.headers.get('mcp-session-id') === 'session')).toBe(true)
    expect(server.calls.filter((c) => c.method === 'tools/call').map((c) => c.params.name)).toEqual(['auth_advertiser_get', 'advertiser_info_get', 'report_integrated_get', 'report_integrated_get'])
  })

  it('splits 56 days into windows of at most 30 days', async () => {
    const server = mockServer()
    const client = new TikTokMcpReadingClient('secret', server.fetchImpl)
    await client.initialize()
    await client.report(ID, '2026-08-06', '2026-09-30')
    const reports = server.calls.filter((c) => c.params.name === 'report_integrated_get').map((c) => c.params.arguments)
    expect(reports).toMatchObject([{ start_date: '2026-08-06', end_date: '2026-09-04' }, { start_date: '2026-09-05', end_date: '2026-09-30' }])
  })

  it('rejects incomplete metrics, out-of-range dates, and duplicate paginated rows', async () => {
    for (const options of [{ missingMetric: true }, { wrongDate: true }, { duplicate: true, pages: 2 }]) {
      const server = mockServer(options)
      const client = new TikTokMcpReadingClient('secret', server.fetchImpl)
      await client.initialize()
      await expect(client.report(ID, '2026-09-01', '2026-09-07')).rejects.toThrow()
    }
  })

  it('fails closed when the discovered read tool is absent or reports an error', async () => {
    for (const options of [{ missing: 'report_integrated_get' }, { fail: true }]) {
      const server = mockServer(options)
      const client = new TikTokMcpReadingClient('secret', server.fetchImpl)
      await client.initialize()
      await expect(client.report(ID, '2026-09-01', '2026-09-07')).rejects.toThrow()
      expect(server.calls.every((c) => c.method !== 'tools/call' || c.params.name === 'report_integrated_get')).toBe(true)
    }
  })
})
