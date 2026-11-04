import { app, BrowserWindow } from 'electron'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/constants'
import type { AppsFlyerConnectionSnapshot } from '../shared/connections'
import { defaultPiAgentDir } from './piSettings'
import { listMcpConnections, removeMcpConnection, upsertManagedServer, type McpStorePaths } from './integrations/mcp/McpConnectionStore'
import { AppsFlyerConnectionManager } from './integrations/appsflyer/AppsFlyerConnectionManager'
import { AppsFlyerReadFacade } from './integrations/appsflyer/AppsFlyerReadFacade'
import { APPSFLYER_SKILL, APPSFLYER_SKILL_FILE, APPSFLYER_SKILL_V1 } from './integrations/appsflyer/appsflyerSkill'
import { openAuthWindow, type AuthWindowHandle } from './integrations/appsflyer/authWindow'

const NAME = 'appsflyer'
const DEFINITION = { id: NAME, kind: 'oauth' as const, label: 'AppsFlyer', description: '连接 AppsFlyer 官方 MCP，读取已有聚合数据。', capabilities: ['mcp'] }
const unavailable = (reason: string): AppsFlyerConnectionSnapshot => ({ definition: DEFINITION, connected: false, status: 'degraded', lastError: reason })
type Obj = Record<string, unknown>
const object = (v: unknown): Obj | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
let manager: AppsFlyerConnectionManager | null = null
let facade: AppsFlyerReadFacade | null = null
let capability: { endpoint: string; token: string } | null = null
let initializing: Promise<void> | null = null
let initialized = false
let initFailed = false
let projected: AppsFlyerConnectionSnapshot = { definition: DEFINITION, connected: false, status: 'disconnected' }
let closing = false

function locations(): McpStorePaths & { marker: string } {
  const data = app.getPath('userData')
  return { mcpJson: path.join(defaultPiAgentDir(), 'mcp.json'), registry: path.join(data, 'mcp-connections.json'), marker: path.join(data, 'appsflyer-mcp-owner.json') }
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
function sync(snapshot: AppsFlyerConnectionSnapshot): AppsFlyerConnectionSnapshot {
  const paths = locations()
  try {
    const state = inspect(paths)
    if (snapshot.connected && capability) {
      if (state.entry && !state.owned) return unavailable('存在同名 AppsFlyer MCP 配置，投手不会覆盖；请先处理现有配置。')
      if (state.disabled) return unavailable('AppsFlyer MCP 当前已禁用，请先在连接设置中启用。')
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
  } catch { return unavailable('无法安全更新 AppsFlyer 本机连接配置，请检查配置文件与访问权限。') }
}
function broadcast(snapshot: AppsFlyerConnectionSnapshot): void {
  projected = snapshot
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.APPSFLYER_STATUS, snapshot)
}
function onChange(snapshot: AppsFlyerConnectionSnapshot): void { if (!closing) broadcast(sync(snapshot)) }
function installSkill(): void {
  const dir = path.join(app.getPath('userData'), 'skills'); mkdirSync(dir, { recursive: true })
  const file = path.join(dir, APPSFLYER_SKILL_FILE)
  const marker = `${file}.hash`
  const wantedHash = createHash('sha256').update(APPSFLYER_SKILL).digest('hex')
  // Preserve edits and hand-written files with the same name.
  try { writeFileSync(file, APPSFLYER_SKILL, { mode: 0o600, flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // An EXISTING file still tracks app upgrades — but only when it is
    // provably ours and unmodified: its content matches the last hash we
    // wrote (or the legacy v1 template from before markers existed). A
    // user-edited file keeps their edits and the new guidance stays out.
    try {
      const current = readFileSync(file, 'utf8')
      const currentHash = createHash('sha256').update(current).digest('hex')
      let lastHash = ''
      try { lastHash = readFileSync(marker, 'utf8').trim() } catch { /* first upgrade path */ }
      const untouched = currentHash === lastHash || current === APPSFLYER_SKILL_V1
      if (untouched && currentHash !== wantedHash) writeFileSync(file, APPSFLYER_SKILL, { mode: 0o600 })
    } catch { /* never let skill refresh break the connection init */ }
  }
  try { writeFileSync(marker, wantedHash, { mode: 0o600 }) } catch { /* best effort */ }
}
export async function initializeAppsFlyerConnection(): Promise<void> {
  if (initialized || initFailed) return
  if (initializing) return initializing
  const pending = (async () => {
    try {
      manager = new AppsFlyerConnectionManager({ onChange })
      facade = new AppsFlyerReadFacade(manager)
      capability = await facade.initialize()
      installSkill()
      await manager.initialize()
      initialized = true
    } catch {
      facade?.close(); facade = null; capability = null; initFailed = true
      broadcast(unavailable('无法初始化 AppsFlyer 连接，请重试。'))
    }
  })()
  initializing = pending
  try { await pending } finally { if (initializing === pending) initializing = null }
}
export async function getAppsFlyerConnectionSnapshot(): Promise<AppsFlyerConnectionSnapshot> { await initializeAppsFlyerConnection(); return projected }
export async function beginAppsFlyerConnection(): Promise<AppsFlyerConnectionSnapshot> {
  if (initFailed) { initFailed = false; initialized = false }
  await initializeAppsFlyerConnection()
  if (!manager || !initialized) return projected
  await manager.begin(); return projected
}
export async function cancelAppsFlyerConnection(): Promise<AppsFlyerConnectionSnapshot> { await initializeAppsFlyerConnection(); if (manager && initialized) manager.cancel(); return projected }
export async function disconnectAppsFlyerConnection(): Promise<AppsFlyerConnectionSnapshot> { await initializeAppsFlyerConnection(); if (manager && initialized) await manager.disconnect(); return projected }
/**
 * Open the authorization page INSIDE the app in a direct-connection window.
 * The user's browser is not used: its proxy state (cached PAC failures, a
 * node that cannot reach the provider) is outside our control, while the
 * in-app window shares the same resilient network path as the API client.
 * The loopback redirect never renders — the window closes on it.
 */
let authWindow: AuthWindowHandle | null = null
export async function openAppsFlyerAuthorizationUrl(url: string): Promise<boolean> {
  await initializeAppsFlyerConnection()
  if (!manager || !initialized) return false
  const snapshot = manager.getSnapshot()
  if (snapshot.status !== 'waiting_for_user' || url !== snapshot.authorizationUrl) return false
  authWindow?.close()
  const redirectPrefix = (snapshot.authorizationUrl?.match(/redirect_uri=([^&]+)/)?.[1] ?? '')
  const prefix = decodeURIComponent(redirectPrefix)
  if (!prefix.startsWith('http://127.0.0.1:')) return false
  const handle = openAuthWindow(url, prefix)
  authWindow = handle
  void handle.done.then(() => { if (authWindow === handle) authWindow = null })
  return true
}
/** Session-scoped loopback capability; never expose the upstream OAuth grant. */
export function appsFlyerToolEnv(): Record<string, string> {
  if (!closing && initialized && projected.connected && capability && manager?.hasVerifiedTools()) {
    return { TOUSHOU_APPSFLYER: JSON.stringify({ url: capability.endpoint, token: capability.token }) }
  }
  return {}
}
/** Why appsFlyerToolEnv came up empty — wiring for the dataset pull's error report. */
export function appsFlyerToolEnvDiag(): Record<string, unknown> {
  return {
    closing,
    initialized,
    projectedStatus: projected.status,
    projectedConnected: projected.connected,
    hasCapability: !!capability,
    hasManager: !!manager,
    manager: manager ? manager.verifiedDiag() : null
  }
}
/**
 * The verified OAuth access token for Main-internal pipelines (the dataset
 * pull). The loopback capability token that agents see is deliberately NOT
 * usable against the official endpoint.
 */
export function verifiedAppsFlyerAccessToken(): string | null {
  return manager ? manager.getVerifiedAccessToken() : null
}
export async function shutdownAppsFlyerConnection(): Promise<void> {
  closing = true
  try {
    authWindow?.close()
    authWindow = null
    if (initializing) await initializing
    manager?.cancel()
    facade?.close()
    try { removeOwned(locations()) } catch { /* best effort on shutdown; stale capability becomes invalid when server closes */ }
  } finally { manager = null; facade = null; capability = null; initialized = false; initFailed = false; projected = { definition: DEFINITION, connected: false, status: 'disconnected' }; closing = false }
}
