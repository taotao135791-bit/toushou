import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ session: {} }))
import { MetaAdsMcpClient } from './MetaAdsMcpClient'
import { META_ADS_MCP_ENDPOINT, META_ADS_TOOLS, validMetaEndpoint } from './constants'

function fixture(options: { sse?: boolean; duplicate?: boolean; denied?: boolean; echoGrant?: boolean } = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(META_ADS_MCP_ENDPOINT)
    expect(init?.redirect).toBe('error')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer synthetic-upstream-grant')
    const message = JSON.parse(String(init?.body))
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (message.method !== 'initialize') expect(headers['Mcp-Session-Id']).toBe('synthetic-session')
    if (options.denied) return new Response('private upstream error', { status: 401 })
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26' }
      : message.method === 'tools/list'
        ? { tools: [...META_ADS_TOOLS, 'update_campaign', ...(options.duplicate ? [META_ADS_TOOLS[0]] : [])].map(name => ({ name, inputSchema: { type: 'object' } })) }
        : { content: [{ type: 'text', text: options.echoGrant ? 'synthetic-upstream-grant' : 'synthetic report' }] }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
    return new Response(options.sse ? `event: message\ndata: ${payload}\n\n` : payload, { headers: { 'content-type': options.sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'synthetic-session' } })
  })
  return { client: new MetaAdsMcpClient('synthetic-upstream-grant', fetcher), fetcher }
}

describe('Meta Ads upstream MCP boundary', () => {
  it.each([false, true])('negotiates the session and filters writes (SSE=%s)', async sse => {
    const { client, fetcher } = fixture({ sse })
    await client.initialize()
    expect(client.toolDescriptions().map(tool => tool.name)).toEqual([...META_ADS_TOOLS])
    const count = fetcher.mock.calls.length
    await expect(client.callReadTool('update_campaign', {})).rejects.toThrow('meta-ads-invalid-query')
    await expect(client.callReadTool(META_ADS_TOOLS[1], { query: 'x'.repeat(32_001) })).rejects.toThrow('meta-ads-invalid-query')
    expect(fetcher).toHaveBeenCalledTimes(count)
    expect(await client.callReadTool(META_ADS_TOOLS[0], {})).toMatchObject({ content: [{ text: 'synthetic report' }] })
  })
  it('rejects duplicate schemas rather than selecting a conflicting tool', async () => {
    await expect(fixture({ duplicate: true }).client.initialize()).rejects.toThrow('meta-ads-invalid-tools')
  })
  it('does not leak provider errors or a returned upstream grant', async () => {
    await expect(fixture({ denied: true }).client.initialize()).rejects.toThrow('meta-ads-authorization-error')
    const { client } = fixture({ echoGrant: true })
    await client.initialize()
    await expect(client.callReadTool(META_ADS_TOOLS[0], {})).rejects.toThrow('meta-ads-invalid-data')
  })
  it('pins endpoint purpose, host and path rather than trusting discovery URLs', () => {
    expect(validMetaEndpoint('https://pipeboard.co/oauth/token', 'token')).toBe(true)
    expect(validMetaEndpoint('https://pipeboard.co/oauth/authorize?platform=meta-ads', 'authorization')).toBe(true)
    expect(validMetaEndpoint('https://pipeboard.co/oauth/register?platform=meta-ads', 'registration')).toBe(true)
    for (const url of ['https://pipeboard.co.evil.test/oauth/token', 'https://pipeboard.co/oauth/token?secret=x', 'https://pipeboard.co/other', 'https://user@pipeboard.co/oauth/token', 'http://pipeboard.co/oauth/token', 'https://www.facebook.com/v26.0/dialog/oauth', 'https://pipeboard.co/oauth/register?platform=google-ads']) {
      expect(validMetaEndpoint(url, 'token')).toBe(false)
    }
    expect(META_ADS_MCP_ENDPOINT).toBe('https://meta-ads.mcp.pipeboard.co/?read_only=true')
  })
})
