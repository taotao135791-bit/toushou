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
