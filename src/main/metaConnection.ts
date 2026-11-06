import { app, BrowserWindow } from 'electron'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/constants'
import type { MetaAdsConnectionSnapshot } from '../shared/connections'
import { defaultPiAgentDir } from './piSettings'
import { listMcpConnections, removeMcpConnection, upsertManagedServer, type McpStorePaths } from './integrations/mcp/McpConnectionStore'
import { MetaAdsConnectionManager } from './integrations/meta/MetaAdsConnectionManager'
import { MetaAdsReadFacade } from './integrations/meta/MetaAdsReadFacade'
import { META_ADS_SKILL, META_ADS_SKILL_FILE } from './integrations/meta/metaAdsSkill'
import { MetaAdsMcpClient } from './integrations/meta/MetaAdsMcpClient'
import { MetaBoardReadError, readMetaAccounts, readMetaSummary } from './integrations/meta/MetaBoardReader'
import { isMetaAccountId, isMetaReadingRange, type MetaReadingAccount, type MetaReadingResult, type MetaReadingSummary } from '../shared/metaReading'
import { boardReadingRangeDates } from '../shared/fbReading'
import { isBoardDate } from '../shared/boardWindows'
import { invalidateBoardRefreshSource } from './boardRefresh'

const NAME = 'meta-ads'
const DEFINITION = { id: NAME, kind: 'oauth' as const, label: 'Meta Ads', description: '连接 Meta Ads MCP（由 Pipeboard 提供），读取已有聚合数据。', capabilities: ['mcp'] }
const unavailable = (reason: string): MetaAdsConnectionSnapshot => ({ definition: DEFINITION, connected: false, status: 'degraded', lastError: reason })
type Obj = Record<string, unknown>
const object = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
let manager: MetaAdsConnectionManager | null = null
let facade: MetaAdsReadFacade | null = null
let capability: { endpoint: string; token: string } | null = null
let initializing: Promise<void> | null = null
let initialized = false
let initFailed = false
let projected: MetaAdsConnectionSnapshot = { definition: DEFINITION, connected: false, status: 'disconnected' }
let closing = false

function locations(): McpStorePaths & { marker: string } {
  const data = app.getPath('userData')
  return { mcpJson: path.join(defaultPiAgentDir(), 'mcp.json'), registry: path.join(data, 'mcp-connections.json'), marker: path.join(data, 'meta-ads-mcp-owner.json') }
}
function readObject(file: string): Obj | null {
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe-file')
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const value = object(parsed); if (!value) throw new Error('invalid-json')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function inspect(paths: McpStorePaths & { marker: string }): { entry: Obj | null; owned: boolean; disabled: boolean } {
  const file = readObject(paths.mcpJson)
  const registry = readObject(paths.registry)
  const marker = readObject(paths.marker)
  if (file?.mcpServers !== undefined && !object(file.mcpServers)) throw new Error('invalid-config')
  if (file?.disabledServers !== undefined && (!Array.isArray(file.disabledServers) || file.disabledServers.some(x => typeof x !== 'string'))) throw new Error('invalid-config')
  if (registry?.managed !== undefined && (!Array.isArray(registry.managed) || registry.managed.some(x => typeof x !== 'string'))) throw new Error('invalid-registry')
  if (marker && (marker.version !== 1 || typeof marker.digest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.digest))) throw new Error('invalid-marker')
  const servers = object(file?.mcpServers)
  const raw = servers?.[NAME]
  if (raw !== undefined && !object(raw)) throw new Error('name-conflict')
  const entry = object(raw)
  const registered = listMcpConnections(paths).find(item => item.name === NAME)
  const digest = entry ? createHash('sha256').update(JSON.stringify(entry)).digest('hex') : null
  return { entry, owned: !!entry && registered?.managed === true && !!marker && marker.digest === digest, disabled: registered?.enabled === false }
}
function safeMarker(paths: ReturnType<typeof locations>, entry: Obj): void {
  mkdirSync(path.dirname(paths.marker), { recursive: true })
  const tmp = `${paths.marker}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, JSON.stringify({ version: 1, digest: createHash('sha256').update(JSON.stringify(entry)).digest('hex') }), { mode: 0o600, flag: 'wx' }); chmodSync(tmp, 0o600); renameSync(tmp, paths.marker) }
  catch (error) { try { unlinkSync(tmp) } catch {} throw error }
}
function secureConfig(paths: McpStorePaths): void {
  mkdirSync(path.dirname(paths.mcpJson), { recursive: true })
  try { writeFileSync(paths.mcpJson, '{}\n', { mode: 0o600, flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = lstatSync(paths.mcpJson)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-config')
  chmodSync(paths.mcpJson, 0o600)
}
function removeOwned(paths: ReturnType<typeof locations>): void {
  const state = inspect(paths)
  if (state.entry && state.owned) {
    const result = removeMcpConnection(NAME, paths)
    if (!result.ok) throw new Error('remove-failed')
  }
  // Never remove another owner's changed config; a stale marker is harmless.
  if (!state.entry || state.owned) { try { unlinkSync(paths.marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}
function sync(snapshot: MetaAdsConnectionSnapshot): MetaAdsConnectionSnapshot {
  const paths = locations()
  try {
    const state = inspect(paths)
    if (snapshot.connected && capability) {
      if (state.entry && !state.owned) return unavailable('存在同名 Meta Ads MCP 配置，投手不会覆盖；请先处理现有配置。')
      if (state.disabled) return unavailable('Meta Ads MCP 当前已禁用，请先在连接设置中启用。')
      const entry = { type: 'http', url: capability.endpoint, timeout: 120000, headers: { Authorization: `Bearer ${capability.token}` } }
      secureConfig(paths)
      // Do not rewrite unchanged configuration on every status update.
      if (!state.owned || JSON.stringify(state.entry) !== JSON.stringify(entry)) {
        const result = upsertManagedServer(NAME, entry, paths)
        if (!result.ok) throw new Error('write-failed')
        safeMarker(paths, entry)
      }
    } else removeOwned(paths)
    return snapshot
  } catch { return unavailable('无法安全更新 Meta Ads 本机连接配置，请检查配置文件与访问权限。') }
}
function broadcast(snapshot: MetaAdsConnectionSnapshot): void {
  if (!snapshot.connected) invalidateBoardRefreshSource('meta')
  projected = snapshot
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.META_ADS_STATUS, snapshot)
}
function onChange(snapshot: MetaAdsConnectionSnapshot): void { if (!closing) broadcast(sync(snapshot)) }
function installSkill(): void {
  const dir = path.join(app.getPath('userData'), 'skills'); mkdirSync(dir, { recursive: true })
  const file = path.join(dir, META_ADS_SKILL_FILE)
  // Preserve edits and hand-written files with the same name.
  try { writeFileSync(file, META_ADS_SKILL, { mode: 0o600, flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
}
export async function initializeMetaAdsConnection(): Promise<void> {
  if (initialized || initFailed) return
  if (initializing) return initializing
  const pending = (async () => {
    try {
      manager = new MetaAdsConnectionManager({ onChange })
      facade = new MetaAdsReadFacade(manager)
      capability = await facade.initialize()
      installSkill()
      await manager.initialize()
      initialized = true
    } catch {
      facade?.close(); facade = null; capability = null; initFailed = true
      broadcast(unavailable('无法初始化 Meta Ads 连接，请重试。'))
    }
  })()
  initializing = pending
  try { await pending } finally { if (initializing === pending) initializing = null }
}
export async function getMetaAdsConnectionSnapshot(): Promise<MetaAdsConnectionSnapshot> { await initializeMetaAdsConnection(); return projected }
let activeReadings = 0
/** Narrow native-board capability; neither raw tool arguments nor grants cross IPC. */
export async function readMetaBoard(input: unknown): Promise<MetaReadingResult<MetaReadingSummary | { accounts: MetaReadingAccount[]; partial: boolean }>> {
  const query = object(input)
  if (!query || (query.action !== 'accounts' && query.action !== 'summary') || (query.action === 'summary' && (!isMetaAccountId(query.accountId) || !isMetaReadingRange(query.range)))) return { ok: false, error: '请选择有效的 Meta 账户和日期范围。' }
  if (Object.keys(query).some(key => !(query.action === 'accounts' ? ['action'] : ['action', 'accountId', 'range', 'window']).includes(key))) return { ok: false, error: 'Meta 读取参数无效。' }
  const requestedWindow = query.window === undefined ? undefined : object(query.window)
  if (query.window !== undefined && (!requestedWindow || Object.keys(requestedWindow).some(key => !['start', 'end'].includes(key)) || !isBoardDate(requestedWindow.start) || !isBoardDate(requestedWindow.end) || requestedWindow.start > requestedWindow.end || Date.parse(requestedWindow.end) - Date.parse(requestedWindow.start) > 29 * 86_400_000)) return { ok: false, error: '请选择有效的 Meta 日期范围（最多30天）。' }
  if (activeReadings >= 4) return { ok: false, error: 'Meta 正在读取，请稍后重试。' }
  activeReadings++
  let token: string | undefined
  try {
    await initializeMetaAdsConnection()
    if (!manager || !initialized || !projected.connected) return { ok: false, error: '请先在连接页授权 Meta Ads。' }
    const credentials = await manager.loadFreshCredentials()
    if (!credentials) return { ok: false, error: 'Meta 授权不可用，请重新连接。' }
    token = credentials.accessToken
    const client = new MetaAdsMcpClient(token, undefined, AbortSignal.timeout(90_000))
    await client.initialize()
    const schema = client.toolDescriptions().find(tool => tool.name === 'get_insights')?.inputSchema as Obj | undefined
    if (query.action === 'summary' && !object(schema?.properties)?.time_breakdown) return { ok: false, error: '当前 Meta 服务未提供每日明细参数，暂不能刷新看板。' }
    const list = await readMetaAccounts(client)
    if ((await manager.loadFreshCredentials())?.accessToken !== token) return { ok: false, error: 'Meta 授权已变化，请重新读取。' }
    if (query.action === 'accounts') return { ok: true, data: list }
    const account = list.accounts.find(item => item.id === query.accountId)
    if (!account) return { ok: false, error: '所选账户不在本次已授权账户列表内，请重新选择。' }
    const range = query.range as MetaReadingSummary['range']
    const data = await readMetaSummary(client, account, range, requestedWindow ? { start: String(requestedWindow.start), end: String(requestedWindow.end) } : boardReadingRangeDates(range))
    const current = await manager.loadFreshCredentials()
    if (current?.accessToken !== token) return { ok: false, error: 'Meta 授权已变化，请重新读取。' }
    return { ok: true, data }
  } catch (error) {
    if (token) manager?.markReadFailure(error, token)
    // Do not expose upstream response text, URLs or credentials.
    return { ok: false, error: error instanceof MetaBoardReadError ? error.message : 'Meta 读取未完成，请检查连接、账户权限、服务额度或返回数据的完整性后重试。' }
  } finally { activeReadings-- }
}
export async function beginMetaAdsConnection(): Promise<MetaAdsConnectionSnapshot> {
  if (initFailed) { initFailed = false; initialized = false }
  await initializeMetaAdsConnection()
  if (!manager || !initialized) return projected
  await manager.begin(); return projected
}
export async function cancelMetaAdsConnection(): Promise<MetaAdsConnectionSnapshot> { await initializeMetaAdsConnection(); if (manager && initialized) manager.cancel(); return projected }
export async function disconnectMetaAdsConnection(): Promise<MetaAdsConnectionSnapshot> { await initializeMetaAdsConnection(); if (manager && initialized) await manager.disconnect(); return projected }
export async function openMetaAdsAuthorizationUrl(url: string): Promise<boolean> { await initializeMetaAdsConnection(); return !!manager && initialized && await manager.openAuthorizationUrl(url) }
export async function shutdownMetaAdsConnection(): Promise<void> {
  closing = true
  try {
    if (initializing) await initializing
    manager?.cancel()
    facade?.close()
    try { removeOwned(locations()) } catch { /* best effort on shutdown; stale capability becomes invalid when server closes */ }
  } finally { manager = null; facade = null; capability = null; initialized = false; initFailed = false; projected = { definition: DEFINITION, connected: false, status: 'disconnected' }; closing = false }
}
