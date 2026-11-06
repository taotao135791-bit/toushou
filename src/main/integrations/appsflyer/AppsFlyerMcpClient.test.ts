import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: {}, session: {}, safeStorage: {} }))
import { AppsFlyerMcpClient, parseApps, parseEvents, eventQueryArguments } from './AppsFlyerMcpClient'
const query = { appId: 'com.example.demo', eventName: 'demo_event', startDate: '2026-11-01', endDate: '2026-11-02' }
const fixture = '## Data: Count days activity appsflyer,Unique users days activity appsflyer,Installs appsflyer,Campaign ID,Campaign,Media source,Date\n2,1,1.0,1234567890123456789,Demo,tiktokglobal_int,2026-11-01\n## Metadata: {"timezone":"UTC","currency":"USD","Count_days_activity_appsflyer":{"partial-data?":false,"filters":{"event-name":["demo_event"]}}}'
describe('AppsFlyer aggregation', () => {
  it('keeps arbitrary custom event selectors and limits discovery to known built-ins', () => {
    expect(() => eventQueryArguments({ ...query, startDate: '2026-02-31' })).toThrow('invalid-query')
    for (const eventName of ['custom_checkout', 'Register', 'demo_event', 'af_purchase']) {
      expect(eventQueryArguments({ ...query, eventName })).toMatchObject({ query: { in_app_event: [eventName], groupings: ['Campaign ID', 'Campaign', 'Media source', 'Date'] } })
    }
    for (const eventName of ['App Active', 'Install', 'Session']) {
      expect(eventQueryArguments({ ...query, eventName })).toMatchObject({ query: { in_app_event: [], groupings: ['Event name', 'Media source', 'Date', 'Campaign ID'] } })
    }
  })
  it('keeps long campaign IDs and original date/timezone semantics', () => { const [r] = parseEvents(fixture, query); expect(r).toMatchObject({ appId: query.appId, campaignId: '1234567890123456789', count: 2, uniqueUsers: 1, day: '2026-11-01', timezone: 'UTC', metricBasis: 'activity', partial: null }) })
  it('parses the official semicolon metadata separator without adding a CSV row', () => {
    const providerFormat = fixture.replace('\n## Metadata:', '\r\n  ; ## Metadata:')
    expect(parseEvents(providerFormat, query)).toEqual(parseEvents(fixture, query))
    expect(parseEvents(providerFormat, query)).toHaveLength(1)
  })
  it('parses only app identity and does not pass owner email through', () => { expect(parseApps('📱 Found 1 app(s) in your account\n\n📱 Apps (1):\n1. Demo app\n   App ID: com.example.demo\n   Platform: android\n   Owner: private@example.test')).toEqual([{ name: 'Demo app', appId: 'com.example.demo', platform: 'android' }]) })
  it('recognizes explicit empty responses, without treating an error containing similar words as empty', () => {
    expect(parseApps('📱 No apps found in your account')).toEqual([])
    expect(parseApps('📱 Found 0 app(s) in your account')).toEqual([])
    expect(() => parseApps('access denied: No apps found in your account')).toThrow()
  })
  it('combines both metric completeness flags and rejects a mismatched unique-user event', () => {
    const addMeta = (more: string) => fixture.replace('"timezone":"UTC"', `${more},"timezone":"UTC"`)
    const meta = (partial: boolean, name = 'demo_event') => `"Unique_users_days_activity_appsflyer":{"partial-data?":${partial},"filters":{"event-name":["${name}"]}}`
    expect(parseEvents(addMeta(meta(false)), query)[0].partial).toBe(false)
    expect(parseEvents(addMeta(meta(true)), query)[0].partial).toBe(true)
    expect(() => parseEvents(addMeta(meta(false, 'another_event')), query)).toThrow('scope')
  })
  it('rejects out of scope rows and truncated result sets', () => { expect(() => parseEvents(fixture.replace('2026-11-01\n##', '2026-11-03\n##'), query)).toThrow('scope'); const line = '2,1,1.0,123,Demo,tiktokglobal_int,2026-11-01'; expect(() => parseEvents(fixture.replace(/2,1,1\.0,.*\n## Metadata:/, `${Array(300).fill(line).join('\n')}\n## Metadata:`), query)).toThrow('incomplete') })
  it('only calls the allowed tools and enforces one app per raw report', async () => {
    const calls: string[] = []; const payloads: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const p = JSON.parse(String(init?.body)); calls.push(p.method + ':' + (p.params?.name ?? ''))
      if (p.method === 'tools/call') payloads.push(p.params.arguments)
      if (!('id' in p)) return new Response(null, { status: 202 })
      const response = p.method === 'initialize' ? { protocolVersion: '2025-03-26' } : p.method === 'tools/list' ? { tools: [{ name: 'get_apps', inputSchema: {} }, { name: 'analytics_fetch_aggregated_data', inputSchema: {} }, { name: 'create_onelink_link', inputSchema: {} }] } : { structuredContent: { result: fixture } }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: response }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' } })
    })
    const c = new AppsFlyerMcpClient('synthetic-token', fetcher); await c.initialize(); expect(c.toolDescriptions().map(t => t.name)).toEqual(['get_apps', 'analytics_fetch_aggregated_data'])
    await c.queryEvents(query); expect(calls).not.toContain('tools/call:create_onelink_link')
    expect((payloads[0].query as Record<string, unknown>).sort_by_metrics).toEqual([{ metric_name: 'Count', order: 'desc' }])
    const raw = eventQueryArguments(query); const rawQuery = raw.query as Record<string, unknown>; delete rawQuery.sort_by_metrics
    await c.queryRaw(raw)
    expect((payloads[1].query as Record<string, unknown>).sort_by_metrics).toEqual([{ metric_name: 'Count', order: 'desc' }])
    rawQuery.metrics = [{ metric_name: 'Unique users' }]; await c.queryRaw(raw)
    expect((payloads[2].query as Record<string, unknown>).sort_by_metrics).toEqual([{ metric_name: 'Unique users', order: 'desc' }])
    rawQuery.sort_by_metrics = [{ metric_name: 'Total attributions', order: 'desc' }]
    await expect(c.queryRaw(raw)).rejects.toThrow('invalid-query')
    const minimal = { query: { app_ids: [query.appId], start_date: query.startDate, end_date: query.endDate, metrics: [{ metric_name: 'Count' }] } }
    await c.queryRaw(minimal)
    expect(payloads[3].query).toMatchObject({ row_count: 25, groupings: [], in_app_event: [], filters: {}, sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }] })
    await c.queryRaw({ query: { ...minimal.query, row_count: null, groupings: null, in_app_event: null, filters: null, sort_by_metrics: null } })
    expect(payloads[4].query).toEqual(payloads[3].query)
    await c.queryRaw({ query: { ...minimal.query, filters: { Geo: ['all'], 'Media source': ['tiktokglobal_int'] } } })
    expect(payloads[5].query).toMatchObject({ filters: { 'Media source': ['tiktokglobal_int'] } })
    expect((payloads[5].query as Record<string, unknown>).filters).not.toHaveProperty('Geo')
    await expect(c.queryRaw({ query: { ...minimal.query, filters: { Geo: ['all', 'SG'] } } })).rejects.toThrow('invalid-query')
    await expect(c.queryRaw({ query: { ...minimal.query, row_count: 301 } })).rejects.toThrow('invalid-query')
    await expect(c.queryRaw({ query: { ...minimal.query, filters: 'invalid' } })).rejects.toThrow('invalid-query')
    const args = eventQueryArguments(query); (args.query as Record<string, unknown>).app_ids = ['one', 'two']
    await expect(c.queryRaw(args)).rejects.toThrow('invalid-query')
  })
  it('rejects provider validation text even when tools/call reports isError=false', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const p = JSON.parse(String(init?.body))
      if (!('id' in p)) return new Response(null, { status: 202 })
      const result = p.method === 'initialize' ? { protocolVersion: '2025-03-26' } : p.method === 'tools/list' ? { tools: [{ name: 'analytics_fetch_aggregated_data' }] } : { isError: false, structuredContent: { data: 'The following metrics have validation errors:\n- Count: Metric Count is an in-app metric, try to use it with in-app event' } }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = new AppsFlyerMcpClient('synthetic-token', fetcher)
    await client.initialize()
    await expect(client.queryRaw(eventQueryArguments(query))).rejects.toThrow('appsflyer-query-validation-error')
  })
})
