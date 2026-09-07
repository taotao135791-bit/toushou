import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('validates a remote handshake and surfaces failures verbatim', async () => {
    const paths = makePaths()
    addMcpConnection({ name: 'remote', url: 'https://mcp.example.com/mcp' }, paths)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 }))
    )
    expect((await testMcpConnection('remote', paths)).ok).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 }))
    )
    const denied = await testMcpConnection('remote', paths)
    expect(denied.ok).toBe(false)
    expect(denied.detail).toContain('401')
  })
})
