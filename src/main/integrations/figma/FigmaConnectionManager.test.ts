import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Loopback probing is faked; the real Figma desktop app is never required.
const paths = vi.hoisted(() => ({ documents: '', userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => paths[key as keyof typeof paths] ?? '/tmp/toushou-figma-fallback',
    isPackaged: false,
    getAppPath: () => paths.documents
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { FigmaConnectionManager } from './FigmaConnectionManager'

function mcpResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function makeFetch(plan: {
  initialize?: () => Response | Promise<Response>
  tools?: () => Response
  networkError?: boolean
}): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = []
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${(JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method}`)
    if (plan.networkError) throw new Error('fetch failed')
    if ((JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method === 'initialize') {
      return plan.initialize ? plan.initialize() : mcpResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } })
    }
    return plan.tools
      ? plan.tools()
      : mcpResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'use_figma' }, { name: 'get_screenshot' }, { name: 'get_metadata' }] } })
  }
  return { fetch, calls }
}

let tempDirs: string[] = []
let sourceTrees: string

beforeEach(async () => {
  paths.documents = await mkdtemp(path.join(os.tmpdir(), 'toushou-fg-docs-'))
  paths.userData = await mkdtemp(path.join(os.tmpdir(), 'toushou-fg-user-'))
  tempDirs = [paths.documents, paths.userData]
  // Minimal bundled-trees fixture: getAppPath()/resources/figma-skills/<name>/SKILL.md
  sourceTrees = path.join(paths.documents, 'resources', 'figma-skills')
  const fs = await import('node:fs')
  for (const name of ['figma-use', 'figma-use-figjam', 'figma-use-motion', 'figma-use-slides']) {
    const dir = path.join(sourceTrees, name, 'references')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(sourceTrees, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n\nSee [gotchas](references/gotchas.md) and [generate](../figma-generate-design/SKILL.md).\n`
    )
    fs.writeFileSync(path.join(dir, 'gotchas.md'), `# gotchas for ${name}\n`)
  }
})

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function makeManager(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  return new FigmaConnectionManager({
    mcpPaths: {
      mcpJson: path.join(paths.userData, 'mcp.json'),
      registry: path.join(paths.userData, 'mcp-connections.json')
    },
    fetchImpl: fetch
  })
}

describe('FigmaConnectionManager', () => {
  it('connects when the local endpoint answers, writing the mcp entry and installing the skills', async () => {
    const { fetch } = makeFetch({})
    const manager = makeManager(fetch)

    const snapshot = await manager.connect()
    expect(snapshot.connected).toBe(true)
    expect(snapshot.toolCount).toBe(3)

    const mcpFile = JSON.parse(await readFile(path.join(paths.userData, 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(mcpFile.mcpServers.figma).toEqual({ type: 'http', url: 'http://127.0.0.1:3845/mcp', timeout: 60_000 })
    const registry = JSON.parse(await readFile(path.join(paths.userData, 'mcp-connections.json'), 'utf-8')) as { managed: string[] }
    expect(registry.managed).toContain('figma')

    // Skill trees copied with references intact.
    const installedTree = path.join(paths.userData, 'figma-skills', 'figma-use', 'references', 'gotchas.md')
    expect((await readFile(installedTree, 'utf-8')).slice(0, 8)).toBe('# gotcha')

    // Flat library entries carry the install header, absolute reference
    // links, and degraded cross-links.
    const flat = await readFile(path.join(paths.userData, 'skills', 'figma-use.md'), 'utf-8')
    expect(flat.startsWith('<!-- installed-by: toushou-figma-connector')).toBe(true)
    expect(flat).toContain(`](${paths.userData}/figma-skills/figma-use/references/gotchas.md)`)
    expect(flat).toContain('generate（未随投手打包：figma-generate-design 工作流技能）')
    expect(flat).not.toContain('](../figma-generate-design')
  })

  it('fails with enable guidance when nothing serves the endpoint', async () => {
    const { fetch } = makeFetch({ networkError: true })
    const manager = makeManager(fetch)
    const snapshot = await manager.connect()
    expect(snapshot.status).toBe('failed')
    expect(snapshot.lastError ?? '').toContain('Dev Mode MCP Server')
    // Nothing was written.
    expect(await readdir(paths.userData)).not.toContain('mcp.json')
  })

  it('reports a non-MCP endpoint distinctly', async () => {
    const { fetch } = makeFetch({ initialize: () => new Response('<html>nope</html>', { status: 200 }) })
    const manager = makeManager(fetch)
    const snapshot = await manager.connect()
    expect(snapshot.status).toBe('failed')
    expect(snapshot.lastError ?? '').toContain('不是 MCP 协议')
  })

  it('initialize restores a managed entry and probes quietly', async () => {
    const fs = await import('node:fs')
    const mcpJson = path.join(paths.userData, 'mcp.json')
    fs.mkdirSync(paths.userData, { recursive: true })
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'http://127.0.0.1:3845/mcp' } } }))
    fs.writeFileSync(path.join(paths.userData, 'mcp-connections.json'), JSON.stringify({ managed: ['figma'] }))

    const { fetch } = makeFetch({})
    const manager = makeManager(fetch)
    await manager.initialize()
    expect(manager.getSnapshot().connected).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(manager.getSnapshot().toolCount).toBe(3)
  })

  it('a connected entry degrades when Figma closes', async () => {
    let serving = true
    const { fetch } = makeFetch({ initialize: () => (serving ? mcpResponse({ jsonrpc: '2.0', result: {} }) : Promise.reject(new Error('down'))) })
    const manager = makeManager(fetch)
    await manager.connect()
    serving = false
    const snapshot = await manager.refreshStatus()
    expect(snapshot.status).toBe('degraded')
    // Reopening Figma restores the connection without a re-connect.
    serving = true
    const again = await manager.refreshStatus()
    expect(again.connected).toBe(true)
  })

  it('disconnect removes the entry, the tree, and only our flat skills', async () => {
    const fs = await import('node:fs')
    const { fetch } = makeFetch({})
    const manager = makeManager(fetch)
    await manager.connect()
    // A user-authored skill must survive the uninstall.
    fs.writeFileSync(path.join(paths.userData, 'skills', 'my-own.md'), 'keep me')

    const snapshot = await manager.disconnect()
    expect(snapshot.connected).toBe(false)
    const mcpFile = JSON.parse(await readFile(path.join(paths.userData, 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(mcpFile.mcpServers.figma).toBeUndefined()
    expect(fs.existsSync(path.join(paths.userData, 'figma-skills'))).toBe(false)
    expect(fs.existsSync(path.join(paths.userData, 'skills', 'figma-use.md'))).toBe(false)
    expect(fs.existsSync(path.join(paths.userData, 'skills', 'my-own.md'))).toBe(true)
  })
})
