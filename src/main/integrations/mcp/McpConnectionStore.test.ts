import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const proxyFetchFor = vi.hoisted(() => vi.fn())
vi.mock('../tiktok/proxyFetch', () => ({ proxyFetchFor }))
import {
  addMcpConnection,
  listMcpConnections,
  McpStorePaths,
  parseMcpAddInput,
  removeMcpConnection,
  testMcpConnection
} from './McpConnectionStore'

const roots: string[] = []

function makePaths(prefillOmp?: string): McpStorePaths {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-store-'))
  roots.push(dir)
  const paths = { mcpJson: path.join(dir, 'mcp.json'), registry: path.join(dir, 'registry.json') }
  if (prefillOmp) writeFileSync(paths.mcpJson, prefillOmp)
  return paths
}

afterEach(() => {
  vi.unstubAllGlobals()
  proxyFetchFor.mockReset()
  while (roots.length > 0) {
    const dir = roots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseMcpAddInput', () => {
  it('builds an http entry from the simple form and wraps plain tokens in Bearer', () => {
    const parsed = parseMcpAddInput({
      name: 'socialpeta',
      url: 'https://mcp.socialpeta.com/mcp',
      token: 'sk-test'
    })
    expect(parsed).toEqual({
      ok: true,
      name: 'socialpeta',
      entry: {
        type: 'http',
        url: 'https://mcp.socialpeta.com/mcp',
        headers: { Authorization: 'Bearer sk-test' }
      }
    })
  })

  it('keeps a custom header name verbatim and never Bearer-wraps it', () => {
    const parsed = parseMcpAddInput({
      name: 'svc',
      url: 'https://example.com/mcp',
      token: 'abc',
      headerName: 'X-Api-Key'
    })
    expect(parsed.ok && (parsed.entry.headers as Record<string, string>)['X-Api-Key']).toBe('abc')
  })

  it('accepts a pasted {"mcpServers": {...}} block with exactly one server', () => {
    const parsed = parseMcpAddInput({
      rawJson: '{"mcpServers":{"socialpeta":{"type":"http","url":"https://a.b/mcp","headers":{"Authorization":"Bearer t"}}}}'
    })
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.name).toBe('socialpeta')
  })

  it('rejects multi-server pastes and malformed input with actionable errors', () => {
    expect(parseMcpAddInput({ rawJson: '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}' }).ok).toBe(false)
    expect(parseMcpAddInput({ rawJson: 'not json' }).ok).toBe(false)
    expect(parseMcpAddInput({ rawJson: '{"type":"http","url":"https://a.b"}' }).ok).toBe(false) // 单条缺名称
    expect(parseMcpAddInput({ name: 'Bad Name', url: 'https://a.b' }).ok).toBe(false)
    expect(parseMcpAddInput({ name: 'x', url: 'ftp://a.b' }).ok).toBe(false)
  })
})

describe('McpConnectionStore files', () => {
  it('adds a managed entry and preserves hand-written neighbors', () => {
    const paths = makePaths(
      JSON.stringify({ mcpServers: { mine: { command: 'npx', args: ['-y', 's'] } } })
    )
    const result = addMcpConnection({ name: 'socialpeta', url: 'https://mcp.example.com/mcp', token: 't' }, paths)
    expect(result.ok).toBe(true)

    const onDisk = JSON.parse(readFileSync(paths.mcpJson, 'utf-8'))
    expect(onDisk.mcpServers.mine).toBeDefined()
    expect(onDisk.mcpServers.socialpeta.type).toBe('http')

    const list = listMcpConnections(paths)
    const mine = list.find((c) => c.name === 'mine')
    const sp = list.find((c) => c.name === 'socialpeta')
    expect(mine?.managed).toBe(false)
    expect(sp?.managed).toBe(true)
    expect(sp?.endpointMasked).toBe('https://mcp.example.com/mcp')
  })

  it('masks query strings out of the endpoint view', () => {
    const paths = makePaths()
    addMcpConnection({ name: 'q', url: 'https://a.b/mcp?key=SECRET', token: 't' }, paths)
    expect(listMcpConnections(paths)[0].endpointMasked).toBe('https://a.b/mcp')
  })

  it('removes managed entries only; hand-written entries are refused', () => {
    const paths = makePaths(
      JSON.stringify({ mcpServers: { mine: { command: 'x' } } })
    )
    addMcpConnection({ name: 'svc', url: 'https://a.b' }, paths)
    expect(removeMcpConnection('mine', paths).ok).toBe(false)
    expect(removeMcpConnection('svc', paths).ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(paths.mcpJson, 'utf-8'))
    expect(onDisk.mcpServers.mine).toBeDefined()
    expect(onDisk.mcpServers.svc).toBeUndefined()
  })

  it('re-adding the same name replaces its entry without duplicating', () => {
    const paths = makePaths()
    addMcpConnection({ name: 'svc', url: 'https://a.b/1' }, paths)
    addMcpConnection({ name: 'svc', url: 'https://a.b/2' }, paths)
    const onDisk = JSON.parse(readFileSync(paths.mcpJson, 'utf-8'))
    expect(Object.keys(onDisk.mcpServers)).toEqual(['svc'])
    expect(onDisk.mcpServers.svc.url).toBe('https://a.b/2')
  })
})

describe('testMcpConnection', () => {
  it('reports stdio servers as runtime-verified', async () => {
    const paths = makePaths(
      JSON.stringify({ mcpServers: { local: { command: 'npx' } } })
    )
    const result = await testMcpConnection('local', paths)
    expect(result.ok).toBe(true)
  })

  it('uses the proxy and a complete session, including paginated SSE tool discovery', async () => {
    const paths = makePaths()
    addMcpConnection({ name: 'remote', url: 'https://mcp.example.com/mcp', token: 'fixture-token' }, paths)
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      calls.push({ body, headers })
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), { headers: { 'Mcp-Session-Id': 'synthetic-session' } })
      expect(headers['mcp-session-id']).toBe('synthetic-session')
      expect(headers['mcp-protocol-version']).toBe('2025-03-26')
      if (body.method === 'notifications/initialized') { expect(body.id).toBeUndefined(); return new Response(null, { status: 202 }) }
      const cursor = (body.params as Record<string, unknown>).cursor
      const result = cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'next' }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    proxyFetchFor.mockResolvedValue(transport)
    expect(await testMcpConnection('remote', paths)).toEqual({ ok: true, detail: '握手成功，发现 2 个工具' })
    expect(calls.map(call => call.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    expect(proxyFetchFor).toHaveBeenCalledWith('https://mcp.example.com/mcp', 'mcp-probe')
    expect(calls.every(call => call.headers.authorization === 'Bearer fixture-token')).toBe(true)
  })

  it('rejects HTTP errors, RPC errors, wrong ids and missing tool lists without leaking secrets', async () => {
    const paths = makePaths()
    addMcpConnection({ name: 'remote', url: 'https://mcp.example.com/mcp?secret=private-url', token: 'private-token' }, paths)
    const cases: Array<(body: Record<string, unknown>) => Response> = [
      () => new Response('private-token', { status: 401 }),
      body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'private-token' } })),
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { protocolVersion: '2025-03-26' } })),
      body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }))
    ]
    for (const build of cases) {
      proxyFetchFor.mockResolvedValue(async (_url: string, init: RequestInit) => build(JSON.parse(String(init.body))))
      const result = await testMcpConnection('remote', paths)
      expect(result.ok).toBe(false)
      expect(result.detail).not.toContain('private-token')
      expect(result.detail).not.toContain('private-url')
    }
    proxyFetchFor.mockRejectedValue(new Error('private-token private-url'))
    const failed = await testMcpConnection('remote', paths)
    expect(failed).toEqual({ ok: false, detail: 'MCP 检测失败，请检查网络或服务配置' })
  })

  it('fails when a post-initialization tool request fails or pagination cycles', async () => {
    const paths = makePaths()
    addMcpConnection({ name: 'remote', url: 'https://mcp.example.com/mcp' }, paths)
    for (const cycle of [false, true]) {
      let pages = 0
      proxyFetchFor.mockResolvedValue(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }))
        pages++
        if (!cycle) return new Response('failure', { status: 503 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: 'again' } }))
      })
      const result = await testMcpConnection('remote', paths)
      expect(result.ok).toBe(false)
      expect(pages).toBe(cycle ? 2 : 1)
    }
  })

  it('rejects a failed initialized notification and caps endless pagination', async () => {
    const paths = makePaths()
    addMcpConnection({ name: 'remote', url: 'https://mcp.example.com/mcp' }, paths)
    for (const failNotification of [true, false]) {
      let pages = 0
      proxyFetchFor.mockResolvedValue(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }))
        if (body.method === 'notifications/initialized') return new Response(null, { status: failNotification ? 403 : 202 })
        pages++
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: `page-${pages}` } }))
      })
      expect((await testMcpConnection('remote', paths)).ok).toBe(false)
      expect(pages).toBe(failNotification ? 0 : 20)
    }
  })

})
