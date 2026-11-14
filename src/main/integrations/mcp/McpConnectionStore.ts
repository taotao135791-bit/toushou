import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { McpAddInput, McpConnectionInfo } from '../../../shared/connections'
import { proxyFetchFor } from '../tiktok/proxyFetch'

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
  // Match the explicit default-runtime profile used by OMP and the other
  // connectors. Never write the real user's MCP when a separate profile was
  // explicitly selected (for example an isolated packaged acceptance test).
  const override = process.env.PI_CODING_AGENT_DIR
  const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE
  const agentDir = override && override.trim() && !override.includes('\0') && path.isAbsolute(override) && (!profile || profile === 'default')
    ? path.normalize(override) : path.join(homedir(), '.omp', 'agent')
  return {
    mcpJson: path.join(agentDir, 'mcp.json'),
    registry: path.join(app.getPath('userData'), 'mcp-connections.json')
  }
}

type JsonSnapshot = { value: Record<string, unknown>; bytes: Buffer | null }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Missing files can be created; invalid or unreadable files must be preserved. */
function readJson(file: string): JsonSnapshot {
  let bytes: Buffer
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('配置文件不是安全的普通文件')
    bytes = readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {}, bytes: null }
    throw new Error('无法安全读取 MCP 配置，请检查文件和访问权限')
  }
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('MCP 配置不是合法 JSON，原文件已保留') }
  if (!object(parsed)) throw new Error('MCP 配置格式无效，原文件已保留')
  return { value: parsed, bytes }
}

function readRegistry(paths: McpStorePaths): JsonSnapshot & { names: string[] } {
  const snapshot = readJson(paths.registry)
  const names = snapshot.value.managed
  if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== 'string'))) {
    throw new Error('MCP 管理记录格式无效，原文件已保留')
  }
  return { ...snapshot, names: (names ?? []) as string[] }
}

function readOmpMcp(paths: McpStorePaths): JsonSnapshot & { config: OmpMcpFile } {
  const snapshot = readJson(paths.mcpJson)
  const { mcpServers, disabledServers } = snapshot.value
  if ((mcpServers !== undefined && (!object(mcpServers) || Object.values(mcpServers).some(entry => !object(entry)))) ||
      (disabledServers !== undefined && (!Array.isArray(disabledServers) || disabledServers.some(name => typeof name !== 'string')))) {
    throw new Error('MCP 配置结构无效，原文件已保留')
  }
  return { ...snapshot, config: snapshot.value as OmpMcpFile }
}

/** Detect changes immediately before replacement. Rename is atomic, but is not
 * a cross-process compare-and-swap: another writer can still race the rename. */
function ensureUnchanged(file: string, expected: Buffer | null): void {
  const current = readJson(file).bytes
  if (expected === null ? current !== null : current === null || !expected.equals(current)) {
    throw new Error('MCP 配置已被其他程序修改，请重试')
  }
}

function atomicWrite(file: string, value: Record<string, unknown>, expected: Buffer | null): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    ensureUnchanged(file, expected)
    if (expected === null) {
      // link refuses to replace a file created since the absence check.
      linkSync(temp, file)
      unlinkSync(temp)
    } else renameSync(temp, file)
  } finally {
    try { unlinkSync(temp) } catch { /* already moved or removed */ }
  }
}

function writeOmpMcp(paths: McpStorePaths, file: OmpMcpFile, expected: Buffer | null): void {
  if (!file.$schema) file.$schema = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json'
  atomicWrite(paths.mcpJson, file, expected)
}

function writeRegistryAfterConfig(paths: McpStorePaths, registry: JsonSnapshot, names: string[]): void {
  try { atomicWrite(paths.registry, { ...registry.value, managed: names }, registry.bytes) }
  catch { throw new Error('MCP 配置已更新，但管理记录未能保存；请检查文件后重试') }
}

function failure(error: unknown): { ok: false; error: string } {
  // Never return filesystem exceptions which can contain private paths.
  return { ok: false, error: error instanceof Error && error.message.startsWith('MCP ') ? error.message : '无法安全保存 MCP 配置，请检查文件和访问权限' }
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
  const managed = new Set(readRegistry(paths).names)
  const file = readOmpMcp(paths).config
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
  try {
    const config = readOmpMcp(paths)
    const registry = readRegistry(paths)
    const existing = config.config.mcpServers?.[parsed.name]
    if (existing && !registry.names.includes(parsed.name)) return { ok: false, error: 'MCP 存在同名手写配置，未覆盖原配置' }
    const file = config.config
    file.mcpServers = { ...file.mcpServers, [parsed.name]: parsed.entry }
    const names = registry.names.includes(parsed.name) ? registry.names : [...registry.names, parsed.name]
    ensureUnchanged(paths.registry, registry.bytes)
    writeOmpMcp(paths, file, config.bytes)
    writeRegistryAfterConfig(paths, registry, names)
    return { ok: true, name: parsed.name }
  } catch (error) { return failure(error) }
}

export function removeMcpConnection(
  name: string,
  paths: McpStorePaths = defaultMcpStorePaths()
): { ok: true } | { ok: false; error: string } {
  try {
    const registry = readRegistry(paths)
    if (!registry.names.includes(name)) {
      return { ok: false, error: '该服务器不是投手添加的（手写配置请直接编辑 ~/.omp/agent/mcp.json）' }
    }
    const config = readOmpMcp(paths)
    const file = config.config
    if (file.mcpServers && Object.prototype.hasOwnProperty.call(file.mcpServers, name)) {
      delete file.mcpServers[name]
      ensureUnchanged(paths.registry, registry.bytes)
      writeOmpMcp(paths, file, config.bytes)
      writeRegistryAfterConfig(paths, registry, registry.names.filter((n) => n !== name))
    } else {
      atomicWrite(paths.registry, { ...registry.value, managed: registry.names.filter((n) => n !== name) }, registry.bytes)
    }
    return { ok: true }
  } catch (error) { return failure(error) }
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
  try {
    const config = readOmpMcp(paths)
    const registry = readRegistry(paths)
    const existing = config.config.mcpServers?.[name]
    if (existing && !registry.names.includes(name)) {
      if (isDeepStrictEqual(existing, validated.entry)) return { ok: true }
      return { ok: false, error: 'MCP 存在同名手写配置，未覆盖原配置' }
    }
    const file = config.config
    file.mcpServers = { ...file.mcpServers, [name]: validated.entry }
    const names = registry.names.includes(name) ? registry.names : [...registry.names, name]
    ensureUnchanged(paths.registry, registry.bytes)
    writeOmpMcp(paths, file, config.bytes)
    writeRegistryAfterConfig(paths, registry, names)
    return { ok: true }
  } catch (error) { return failure(error) }
}

/** Extract JSON-RPC messages from JSON or multi-line SSE events. */
function parseRpcResponses(text: string): Array<Record<string, unknown>> {
  const parse = (value: string): Record<string, unknown> | null => {
    try {
      const item: unknown = JSON.parse(value)
      return item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    } catch { return null }
  }
  const direct = parse(text)
  if (direct) return [direct]
  return text.split(/\r?\n\r?\n/).flatMap(event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    const parsed = data ? parse(data) : null
    return parsed ? [parsed] : []
  })
}

/**
 * Test a remote Streamable HTTP MCP session with no business-tool calls.
 * A successful result requires a validated initialization and complete,
 * bounded tool discovery; provider response text is never shown to users.
 */
export async function testMcpConnection(
  name: string,
  paths: McpStorePaths = defaultMcpStorePaths()
): Promise<{ ok: boolean; detail: string }> {
  let entry: Record<string, unknown> | undefined
  try { entry = (readOmpMcp(paths).config.mcpServers ?? {})[name] }
  catch { return { ok: false, detail: '无法读取 MCP 配置，请检查配置文件与访问权限' } }
  if (!entry) return { ok: false, detail: '服务器不存在' }
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  if (type !== 'http' && type !== 'sse') {
    return { ok: true, detail: 'stdio 服务器由运行时启动时验证' }
  }
  const url = String(entry.url)
  const headers = (entry.headers as Record<string, string>) ?? {}
  const overall = AbortSignal.timeout(30_000)
  let sessionId: string | null = null
  let version = '2025-03-26'
  let requestId = 0
  try {
    const send = async (method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, unknown>> => {
      const id = ++requestId
      const requestHeaders = new Headers(headers)
      requestHeaders.set('content-type', 'application/json')
      requestHeaders.set('accept', 'application/json, text/event-stream')
      // These values belong to this handshake, never to stale saved headers.
      requestHeaders.delete('Mcp-Session-Id')
      requestHeaders.delete('MCP-Protocol-Version')
      if (sessionId) requestHeaders.set('Mcp-Session-Id', sessionId)
      if (method !== 'initialize') requestHeaders.set('MCP-Protocol-Version', version)
      const fetch = await proxyFetchFor(url, 'mcp-probe')
      const response = await fetch(url, {
        method: 'POST', headers: requestHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
        signal: AbortSignal.any([overall, AbortSignal.timeout(8000)])
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const currentSession = response.headers.get('mcp-session-id')
      if (currentSession) sessionId = currentSession
      if (notification) return {}
      const payloads = parseRpcResponses(await response.text())
      const message = payloads.find(item => item.jsonrpc === '2.0' && item.id === id)
      if (!message || message.error || !message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
        throw new Error('invalid-rpc-response')
      }
      return message.result as Record<string, unknown>
    }
    const init = await send('initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'toushou-probe', version: '1.0' }
    })
    if (typeof init.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) throw new Error('invalid-protocol')
    version = init.protocolVersion
    await send('notifications/initialized', {}, true)
    let cursor: string | undefined
    const seen = new Set<string>()
    let count = 0
    for (let page = 0; page < 20; page++) {
      const result = await send('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(result.tools) || result.tools.some(tool => !tool || typeof tool !== 'object' || typeof (tool as Record<string, unknown>).name !== 'string')) throw new Error('invalid-tool-list')
      count += result.tools.length
      if (count > 10000) throw new Error('tool-limit')
      if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === '') return { ok: true, detail: `握手成功，发现 ${count} 个工具` }
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || seen.has(result.nextCursor)) throw new Error('invalid-cursor')
      cursor = result.nextCursor
      seen.add(cursor)
    }
    throw new Error('page-limit')
  } catch (error) {
    // HTTP status is safe to expose; request URLs, headers, provider messages,
    // network exceptions and response bodies may contain credentials.
    const match = error instanceof Error ? /^HTTP (\d{3})$/.exec(error.message) : null
    return { ok: false, detail: match ? `MCP 检测失败：HTTP ${match[1]}` : 'MCP 检测失败，请检查网络或服务配置' }
  }
}

export function mcpFileExists(paths: McpStorePaths = defaultMcpStorePaths()): boolean {
  return existsSync(paths.mcpJson)
}
