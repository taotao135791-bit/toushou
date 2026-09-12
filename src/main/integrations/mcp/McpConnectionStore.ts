import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { McpAddInput, McpConnectionInfo } from '../../../shared/connections'

/**
 * MCP connection store — 投手 is the configuration steward, not a bridge.
 *
 * The runtime natively discovers MCP servers from its own user-level
 * `~/.omp/agent/mcp.json`; this module is the ONLY writer 投手 needs: it
 * merges pasted/typed server entries into that file (never touching entries
 * it does not own) and remembers which names it manages in a separate
 * registry under userData. Secrets (tokens in headers) stay in the runtime's
 * config file on the user's own disk — the renderer only ever sees masked
 * endpoints.
 */

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

interface OmpMcpFile {
  mcpServers?: Record<string, Record<string, unknown>>
  disabledServers?: string[]
  [key: string]: unknown
}

export interface McpStorePaths {
  mcpJson: string
  registry: string
}

export function defaultMcpStorePaths(): McpStorePaths {
  return {
    mcpJson: path.join(homedir(), '.omp', 'agent', 'mcp.json'),
    registry: path.join(app.getPath('userData'), 'mcp-connections.json')
  }
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readRegistry(paths: McpStorePaths): string[] {
  const raw = readJson(paths.registry)
  const names = Array.isArray(raw.managed) ? raw.managed : []
  return names.filter((n): n is string => typeof n === 'string')
}

function writeRegistry(paths: McpStorePaths, names: string[]): void {
  mkdirSync(path.dirname(paths.registry), { recursive: true })
  writeFileSync(paths.registry, JSON.stringify({ managed: names }, null, 2))
}

function readOmpMcp(paths: McpStorePaths): OmpMcpFile {
  return readJson(paths.mcpJson) as OmpMcpFile
}

function writeOmpMcp(paths: McpStorePaths, file: OmpMcpFile): void {
  mkdirSync(path.dirname(paths.mcpJson), { recursive: true })
  if (!file.$schema) {
    file.$schema =
      'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json'
  }
  writeFileSync(paths.mcpJson, JSON.stringify(file, null, 2))
}

function maskEndpoint(entry: Record<string, unknown>): string {
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  if (type === 'http' || type === 'sse') {
    try {
      const url = new URL(String(entry.url))
      return `${url.protocol}//${url.host}${url.pathname}`
    } catch {
      return '(无效地址)'
    }
  }
  const command = typeof entry.command === 'string' ? entry.command : ''
  const firstArg = Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? ` ${entry.args[0]}` : ''
  return `${command}${firstArg}`.trim() || '(stdio)'
}

/** Normalize the user's input (paste or form) into name + validated entry. */
export function parseMcpAddInput(input: McpAddInput): { ok: true; name: string; entry: Record<string, unknown> } | { ok: false; error: string } {
  if (input.rawJson && input.rawJson.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input.rawJson)
    } catch {
      return { ok: false, error: '粘贴的内容不是合法 JSON' }
    }
    const root = parsed as Record<string, unknown>
    // Shape 1: {"mcpServers": {name: entry}} — take entries as-is, require exactly one for a single connection card.
    const servers = root.mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      const entries = Object.entries(servers as Record<string, unknown>).filter(
        ([, v]) => v && typeof v === 'object'
      )
      if (entries.length === 0) return { ok: false, error: 'mcpServers 里没有服务器条目' }
      if (entries.length > 1) {
        return { ok: false, error: `包含 ${entries.length} 个服务器，一次只能添加一个（${entries.map(([n]) => n).join(', ')}）` }
      }
      const [name, entry] = entries[0]
      return validateEntry(name, entry as Record<string, unknown>)
    }
    // Shape 2: a single entry object {type, url[, headers]} / {command, args}.
    if (root.type || root.command) {
      const name = (input.name || '').trim()
      if (!name) return { ok: false, error: '单个服务器配置需要先填一个服务名称' }
      return validateEntry(name, root)
    }
    return { ok: false, error: '无法识别的配置格式：需要 {"mcpServers": {...}} 或单个服务器对象' }
  }

  // Form mode: name + url (+ token).
  const name = (input.name || '').trim()
  const url = (input.url || '').trim()
  if (!name || !url) return { ok: false, error: '名称和服务器地址必填' }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, error: '服务器地址不是合法 URL' }
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { ok: false, error: '服务器地址必须是 http(s)://' }
  }
  const entry: Record<string, unknown> = { type: 'http', url: parsedUrl.toString() }
  const token = (input.token || '').trim()
  if (token) {
    const headerName = (input.headerName || 'Authorization').trim() || 'Authorization'
    entry.headers = { [headerName]: token.startsWith('Bearer') || headerName.toLowerCase() !== 'authorization' ? token : `Bearer ${token}` }
  }
  return validateEntry(name, entry)
}

function validateEntry(name: string, entry: Record<string, unknown>): { ok: true; name: string; entry: Record<string, unknown> } | { ok: false; error: string } {
  if (!SERVER_NAME_RE.test(name)) {
    return { ok: false, error: `服务名称 "${name}" 不合法（小写字母/数字/-/_，最长40）` }
  }
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  if (type === 'http' || type === 'sse') {
    if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) {
      return { ok: false, error: `${type} 服务器需要合法的 http(s) url` }
    }
    if (entry.headers !== undefined && (typeof entry.headers !== 'object' || Array.isArray(entry.headers))) {
      return { ok: false, error: 'headers 必须是对象' }
    }
    return { ok: true, name, entry }
  }
  if (type === 'stdio' || entry.command) {
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      return { ok: false, error: 'stdio 服务器需要 command' }
    }
    return { ok: true, name, entry: { ...entry, type: 'stdio' } }
  }
  return { ok: false, error: `不支持的服务器类型: ${String(entry.type)}` }
}

/** Managed + hand-written entries as a masked listing for the renderer. */
export function listMcpConnections(paths: McpStorePaths = defaultMcpStorePaths()): McpConnectionInfo[] {
  const managed = new Set(readRegistry(paths))
  const file = readOmpMcp(paths)
  const servers = file.mcpServers ?? {}
  const disabled = new Set(Array.isArray(file.disabledServers) ? file.disabledServers : [])
  const out: McpConnectionInfo[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') continue
    out.push({
      name,
      transport: (typeof (entry as Record<string, unknown>).type === 'string'
        ? ((entry as Record<string, unknown>).type as string)
        : 'stdio') as McpConnectionInfo['transport'],
      endpointMasked: maskEndpoint(entry as Record<string, unknown>),
      managed: managed.has(name),
      enabled: !disabled.has(name)
    })
  }
  return out.sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name))
}

export function addMcpConnection(
  input: McpAddInput,
  paths: McpStorePaths = defaultMcpStorePaths()
): { ok: true; name: string } | { ok: false; error: string } {
  const parsed = parseMcpAddInput(input)
  if (!parsed.ok) return parsed
  const file = readOmpMcp(paths)
  file.mcpServers = file.mcpServers ?? {}
  file.mcpServers[parsed.name] = parsed.entry
  writeOmpMcp(paths, file)
  const managed = readRegistry(paths)
  if (!managed.includes(parsed.name)) managed.push(parsed.name)
  writeRegistry(paths, managed)
  return { ok: true, name: parsed.name }
}

export function removeMcpConnection(
  name: string,
  paths: McpStorePaths = defaultMcpStorePaths()
): { ok: true } | { ok: false; error: string } {
  const managed = readRegistry(paths)
  if (!managed.includes(name)) {
    return { ok: false, error: '该服务器不是投手添加的（手写配置请直接编辑 ~/.omp/agent/mcp.json）' }
  }
  const file = readOmpMcp(paths)
  if (file.mcpServers && name in file.mcpServers) {
    delete file.mcpServers[name]
    writeOmpMcp(paths, file)
  }
  writeRegistry(paths, managed.filter((n) => n !== name))
  return { ok: true }
}

/**
 * First-party-connection upsert (TikTok Ads-style OAuth connectors): same
 * ownership registry as a user add, but the entry is Main-built and carries a
 * bearer header minted from the app's own credential store. Overwrites only
 * THIS name; other entries are untouched.
 */
export function upsertManagedServer(
  name: string,
  entry: Record<string, unknown>,
  paths: McpStorePaths = defaultMcpStorePaths()
): { ok: true } | { ok: false; error: string } {
  const validated = validateEntry(name, entry)
  if (!validated.ok) return validated
  const file = readOmpMcp(paths)
  file.mcpServers = file.mcpServers ?? {}
  file.mcpServers[name] = validated.entry
  writeOmpMcp(paths, file)
  const managed = readRegistry(paths)
  if (!managed.includes(name)) managed.push(name)
  writeRegistry(paths, managed)
  return { ok: true }
}

/** Extract JSON-RPC payloads from a direct JSON or SSE (data: …) response body. */
function parseRpcResponses(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    try {
      const parsed = JSON.parse(trimmed.slice(5).trim())
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      /* 忽略非 JSON 的 data 行 */
    }
  }
  if (out.length === 0) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      /* 非 JSON */
    }
  }
  return out
}

async function rpcCall(
  url: string,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: Record<string, unknown>
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(8000)
  })
}

/**
 * Live remote verification per the MCP spec: initialize, then tools/list.
 * Reports the discovered tool count so the user sees the service is actually
 * usable, not merely reachable. stdio servers are runtime-verified instead.
 */
export async function testMcpConnection(
  name: string,
  paths: McpStorePaths = defaultMcpStorePaths()
): Promise<{ ok: boolean; detail: string }> {
  const entry = (readOmpMcp(paths).mcpServers ?? {})[name] as Record<string, unknown> | undefined
  if (!entry) return { ok: false, detail: '服务器不存在' }
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  if (type !== 'http' && type !== 'sse') {
    return { ok: true, detail: 'stdio 服务器由运行时启动时验证' }
  }
  const url = String(entry.url)
  const headers = (entry.headers as Record<string, string>) ?? {}
  try {
    const init = await rpcCall(url, headers, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'toushou-probe', version: '1.0' }
    })
    if (!init.ok) return { ok: false, detail: `握手失败：HTTP ${init.status}` }
    const initText = await init.text()
    if (!initText.includes('"jsonrpc"')) {
      return { ok: false, detail: '响应不是 MCP 协议（检查地址是否为 MCP 端点）' }
    }

    let detail = '握手成功'
    try {
      const tools = await rpcCall(url, headers, 2, 'tools/list', {})
      if (tools.ok) {
        const payloads = parseRpcResponses(await tools.text())
        const result = payloads.find((p) => p.result && typeof p.result === 'object')?.result as
          | { tools?: unknown[] }
          | undefined
        if (result && Array.isArray(result.tools)) {
          detail = `握手成功，发现 ${result.tools.length} 个工具`
        }
      }
    } catch {
      /* tools/list 失败不影响连接判定 */
    }
    return { ok: true, detail }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : '网络错误' }
  }
}

export function mcpFileExists(paths: McpStorePaths = defaultMcpStorePaths()): boolean {
  return existsSync(paths.mcpJson)
}
