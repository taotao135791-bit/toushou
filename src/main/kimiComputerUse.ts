import { ChildProcess, spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  KimiComputerUseMutationResult,
  KimiComputerUseReadiness,
  KimiComputerUseStatus
} from '../shared/types'

/**
 * The Kimi CU runtime is deliberately not bundled or installed by OMP GUI.
 * Kimi publishes it as a separately permissioned desktop capability; this
 * module only detects the official app, validates its stdio MCP surface, and
 * writes a narrowly owned OMP MCP registration after an explicit user action.
 */

export const KIMI_CU_DOWNLOAD_URL =
  'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html'
export const KIMI_CU_MCP_SERVER_ID = 'omp-gui-kimi-cu'
export const KIMI_CU_APP_PATH = '/Applications/KimiCU.app'
export const KIMI_CU_BINARY_PATH = path.join(KIMI_CU_APP_PATH, 'Contents', 'MacOS', 'kimi-cu')
export const KIMI_CU_INFO_PLIST_PATH = path.join(KIMI_CU_APP_PATH, 'Contents', 'Info.plist')

const MCP_SCHEMA_URL =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json'
const MCP_PROBE_TIMEOUT_MS = 7_000
const COMMAND_TIMEOUT_MS = 4_000
const MAX_MCP_LINE_BYTES = 512 * 1024
const MAX_DIAGNOSTIC_LENGTH = 360

type JsonObject = Record<string, unknown>

interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

interface KimiMcpProbeResult {
  ok: boolean
  toolCount: number
  error?: string
}

interface KimiCuPaths {
  appPath: string
  binaryPath: string
  infoPlistPath: string
  ompMcpConfigPath: string
}

interface OmpMcpConfigState {
  configured: boolean
  /** The file is malformed or has an incompatible mcpServers field. */
  error?: string
}

interface OmpMcpConfig extends JsonObject {
  mcpServers?: Record<string, unknown>
  disabledServers?: unknown
}

function defaultPaths(): KimiCuPaths {
  return {
    appPath: KIMI_CU_APP_PATH,
    binaryPath: KIMI_CU_BINARY_PATH,
    infoPlistPath: KIMI_CU_INFO_PLIST_PATH,
    ompMcpConfigPath: path.join(homedir(), '.omp', 'agent', 'mcp.json')
  }
}

function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, MAX_DIAGNOSTIC_LENGTH) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Official Kimi CU `xpc-ping` output parser; pure and unit-tested. */
export function parseKimiCuPermissions(output: string): {
  accessibilityGranted: boolean
  screenRecordingGranted: boolean
} | null {
  const match = /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
    output
  )
  if (!match) return null
  return { accessibilityGranted: match[1] === 'true', screenRecordingGranted: match[2] === 'true' }
}

/** Official Kimi CU `service-status` output parser; pure and unit-tested. */
export function parseKimiCuServiceStatus(output: string): boolean | null {
  const match = /\bstatus=(\d+)\b/.exec(output)
  if (!match) return null
  return match[1] === '1'
}

export function buildKimiCuMcpServer(binaryPath: string): JsonObject {
  return {
    type: 'stdio',
    command: binaryPath,
    args: ['mcp'],
    // Kimi CU actions can include screenshot capture/readback; give the OMP
    // MCP client a bounded but practical window instead of the CLI default.
    timeout: 120_000
  }
}

function isManagedMcpServer(value: unknown, binaryPath: string): boolean {
  const server = asRecord(value)
  if (!server || server.enabled === false) return false
  if (server.type !== undefined && server.type !== 'stdio') return false
  if (server.command !== binaryPath) return false
  if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== 'mcp') return false
  return true
}

/**
 * Inspect opaque user-level OMP config without exposing it. This intentionally
 * refuses to treat malformed config as an empty one: a GUI action must never
 * erase another tool's MCP registrations or credentials to repair it.
 */
export function inspectKimiCuMcpConfig(raw: string | null, binaryPath: string): OmpMcpConfigState {
  if (raw === null) return { configured: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { configured: false, error: 'OMP MCP configuration is not valid JSON.' }
  }
  const config = asRecord(parsed)
  if (!config) return { configured: false, error: 'OMP MCP configuration must be a JSON object.' }
  if (config.mcpServers !== undefined && !asRecord(config.mcpServers)) {
    return { configured: false, error: 'OMP MCP configuration has an invalid mcpServers field.' }
  }
  const servers = asRecord(config.mcpServers) ?? {}
  const existing = servers[KIMI_CU_MCP_SERVER_ID]
  // The key is app-owned only when it is still the exact, constrained stdio
  // registration we wrote. A manual/foreign entry under the same name is not
  // safe to overwrite, even when the person is trying to enable the bridge.
  if (existing !== undefined && !isManagedMcpServer(existing, binaryPath)) {
    return {
      configured: false,
      error: 'The Kimi CU bridge entry was changed outside OMP GUI; it was left untouched.'
    }
  }
  return { configured: existing !== undefined }
}

function readKimiCuMcpConfig(paths: KimiCuPaths): OmpMcpConfigState {
  if (!existsSync(paths.ompMcpConfigPath)) return { configured: false }
  try {
    return inspectKimiCuMcpConfig(readFileSync(paths.ompMcpConfigPath, 'utf-8'), paths.binaryPath)
  } catch {
    return { configured: false, error: 'Could not read OMP MCP configuration.' }
  }
}

function readKimiCuVersion(infoPlistPath: string): string | undefined {
  try {
    const plist = readFileSync(infoPlistPath, 'utf-8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

function safeKimiEnv(): NodeJS.ProcessEnv {
  // Kimi CU talks to its own registered XPC service. Preserve only the OS
  // context it needs rather than forwarding provider credentials into it.
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    FORCE_COLOR: '0'
  }
}

function runKimiCommand(binaryPath: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawnChild(binaryPath, args, { env: safeKimiEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: boundedDetail(error instanceof Error ? error.message : String(error)) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout, stderr, error: boundedDetail(error) })
    }
    const append = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (target === 'stdout') stdout = (stdout + chunk.toString('utf-8')).slice(-20_000)
      else stderr = (stderr + chunk.toString('utf-8')).slice(-20_000)
    }
    proc.stdout?.on('data', append('stdout'))
    proc.stderr?.on('data', append('stderr'))
    proc.once('error', (error) => finish(false, error.message))
    proc.once('exit', (code) => finish(code === 0, code === 0 ? undefined : stderr || stdout || `exit code ${code}`))
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish(false, 'Kimi CU probe timed out.')
    }, timeoutMs)
  })
}

/**
 * A tiny, bounded MCP stdio client used only for health verification. It does
 * not expose arbitrary tool calls through IPC; OMP owns normal agent tool use
 * after the user explicitly enables the managed MCP registration.
 */
export function probeKimiCuMcp(binaryPath = KIMI_CU_BINARY_PATH): Promise<KimiMcpProbeResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawnChild(binaryPath, ['mcp'], { env: safeKimiEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, toolCount: 0, error: boundedDetail(error instanceof Error ? error.message : String(error)) })
      return
    }

    let pending = ''
    let stderr = ''
    let settled = false
    let initialized = false
    const finish = (result: KimiMcpProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.stdin?.end()
      } catch {
        // stdin can already be closed after a failed spawn.
      }
      if (!proc.killed) proc.kill('SIGTERM')
      resolve(result)
    }
    const send = (message: JsonObject) => {
      try {
        proc.stdin?.write(JSON.stringify(message) + '\n')
      } catch (error) {
        finish({ ok: false, toolCount: 0, error: boundedDetail(error instanceof Error ? error.message : String(error)) })
      }
    }
    const handleLine = (line: string) => {
      if (line.length > MAX_MCP_LINE_BYTES) {
        finish({ ok: false, toolCount: 0, error: 'Kimi CU MCP response exceeded the safety limit.' })
        return
      }
      let message: JsonObject | null = null
      try {
        message = asRecord(JSON.parse(line))
      } catch {
        return
      }
      if (!message) return
      if (message.id === 1 && !initialized) {
        if (message.error) {
          finish({ ok: false, toolCount: 0, error: 'Kimi CU rejected the MCP initialize request.' })
          return
        }
        initialized = true
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        return
      }
      if (message.id === 2) {
        const result = asRecord(message.result)
        const tools = Array.isArray(result?.tools) ? result?.tools : null
        if (!tools) {
          finish({ ok: false, toolCount: 0, error: 'Kimi CU returned an invalid MCP tool list.' })
          return
        }
        finish({ ok: true, toolCount: tools.length })
      }
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf-8')
      if (pending.length > MAX_MCP_LINE_BYTES * 2) {
        finish({ ok: false, toolCount: 0, error: 'Kimi CU MCP output exceeded the safety limit.' })
        return
      }
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) handleLine(line)
        if (settled) return
        newline = pending.indexOf('\n')
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-8_000)
    })
    proc.once('error', (error) => finish({ ok: false, toolCount: 0, error: boundedDetail(error.message) }))
    proc.once('exit', (code) => {
      if (!settled) {
        finish({ ok: false, toolCount: 0, error: boundedDetail(stderr || `Kimi CU MCP exited (${code ?? 'unknown'}).`) })
      }
    })
    const timer = setTimeout(
      () => finish({ ok: false, toolCount: 0, error: 'Kimi CU MCP connection timed out.' }),
      MCP_PROBE_TIMEOUT_MS
    )
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'omp-gui', version: 'bridge-probe' }
      }
    })
  })
}

function emptyStatus(readiness: KimiComputerUseReadiness, detail?: string): KimiComputerUseStatus {
  return {
    readiness,
    installed: false,
    serviceRunning: false,
    accessibilityGranted: false,
    screenRecordingGranted: false,
    configured: false,
    bridgeReachable: false,
    toolCount: 0,
    detail: boundedDetail(detail),
    downloadUrl: KIMI_CU_DOWNLOAD_URL
  }
}

export async function getKimiComputerUseStatus(overrides: Partial<KimiCuPaths> = {}): Promise<KimiComputerUseStatus> {
  if (process.platform !== 'darwin') {
    return emptyStatus('unsupported-platform', 'Kimi Computer Use is currently supported by this bridge on macOS.')
  }
  const paths = { ...defaultPaths(), ...overrides }
  const configuredState = readKimiCuMcpConfig(paths)
  if (configuredState.error) {
    const status = emptyStatus('configuration-error', configuredState.error)
    status.configured = false
    return status
  }
  if (!existsSync(paths.binaryPath)) {
    const status = emptyStatus('not-installed', 'Install Kimi Computer Use, then refresh this status.')
    status.configured = configuredState.configured
    return status
  }

  const [service, permissions] = await Promise.all([
    runKimiCommand(paths.binaryPath, ['service-status']),
    runKimiCommand(paths.binaryPath, ['xpc-ping'])
  ])
  const serviceRunning = service.ok && parseKimiCuServiceStatus(service.stdout) === true
  const permissionStatus = permissions.ok ? parseKimiCuPermissions(permissions.stdout) : null
  const accessibilityGranted = permissionStatus?.accessibilityGranted === true
  const screenRecordingGranted = permissionStatus?.screenRecordingGranted === true
  const status: KimiComputerUseStatus = {
    readiness: 'ready',
    installed: true,
    serviceRunning,
    accessibilityGranted,
    screenRecordingGranted,
    configured: configuredState.configured,
    bridgeReachable: false,
    toolCount: 0,
    version: readKimiCuVersion(paths.infoPlistPath),
    downloadUrl: KIMI_CU_DOWNLOAD_URL
  }
  if (!serviceRunning) {
    status.readiness = 'service-unavailable'
    status.detail = boundedDetail(service.error ?? 'Kimi CU background service is not running.')
    return status
  }
  if (!accessibilityGranted || !screenRecordingGranted) {
    status.readiness = 'permission-required'
    const missing = [
      ...(accessibilityGranted ? [] : ['Accessibility']),
      ...(screenRecordingGranted ? [] : ['Screen Recording'])
    ]
    status.detail = `Kimi CU needs: ${missing.join(', ')}.`
    return status
  }

  const probe = await probeKimiCuMcp(paths.binaryPath)
  status.bridgeReachable = probe.ok
  status.toolCount = probe.toolCount
  if (!probe.ok) {
    status.readiness = 'bridge-unreachable'
    status.detail = boundedDetail(probe.error)
  }
  return status
}

function readMutableMcpConfig(configPath: string): OmpMcpConfig | { error: string } {
  if (!existsSync(configPath)) return { $schema: MCP_SCHEMA_URL, mcpServers: {} }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return { error: 'OMP MCP configuration is not valid JSON. Fix it before changing the Kimi CU bridge.' }
  }
  const config = asRecord(raw)
  if (!config) return { error: 'OMP MCP configuration must be a JSON object.' }
  if (config.mcpServers !== undefined && !asRecord(config.mcpServers)) {
    return { error: 'OMP MCP configuration has an invalid mcpServers field.' }
  }
  return { ...config, mcpServers: { ...(asRecord(config.mcpServers) ?? {}) } }
}

function hasError(value: OmpMcpConfig | { error: string }): value is { error: string } {
  return 'error' in value
}

function writeMcpConfigAtomically(configPath: string, config: OmpMcpConfig): void {
  const dir = path.dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const tmp = `${configPath}.omp-gui-kimi-cu-${process.pid}-${Date.now()}`
  let mode = 0o600
  try {
    mode = statSync(configPath).mode & 0o777
  } catch {
    // New file stays private by default.
  }
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode, flag: 'wx' })
    renameSync(tmp, configPath)
  } finally {
    // A failed rename leaves the temp file behind; do not delete arbitrary
    // config paths here. The uniquely generated temp is harmless and private.
  }
}

/**
 * Add/remove only the bridge's own OMP MCP entry. Disabling never deletes a
 * colliding user-owned definition — that would be an unsafe surprise.
 */
export async function setKimiComputerUseEnabled(
  enabled: boolean,
  overrides: Partial<KimiCuPaths> = {}
): Promise<KimiComputerUseMutationResult> {
  const initial = await getKimiComputerUseStatus(overrides)
  if (enabled && initial.readiness !== 'ready') {
    return { ok: false, status: initial, error: initial.detail ?? 'Kimi Computer Use is not ready.' }
  }
  const paths = { ...defaultPaths(), ...overrides }
  const config = readMutableMcpConfig(paths.ompMcpConfigPath)
  if (hasError(config)) {
    return {
      ok: false,
      status: { ...initial, readiness: 'configuration-error', detail: config.error },
      error: config.error
    }
  }
  const servers = config.mcpServers ?? {}
  const current = servers[KIMI_CU_MCP_SERVER_ID]
  if (current !== undefined && !isManagedMcpServer(current, paths.binaryPath)) {
    const error = 'The Kimi CU bridge entry was changed outside OMP GUI; it was left untouched.'
    return { ok: false, status: { ...initial, readiness: 'configuration-error', detail: error }, error }
  }
  if (enabled) servers[KIMI_CU_MCP_SERVER_ID] = buildKimiCuMcpServer(paths.binaryPath)
  else delete servers[KIMI_CU_MCP_SERVER_ID]
  config.mcpServers = servers
  if (!config.$schema) config.$schema = MCP_SCHEMA_URL
  try {
    writeMcpConfigAtomically(paths.ompMcpConfigPath, config)
  } catch (error) {
    const detail = boundedDetail(error instanceof Error ? error.message : String(error)) ?? 'Could not update OMP MCP configuration.'
    return { ok: false, status: { ...initial, readiness: 'configuration-error', detail }, error: detail }
  }
  const status = await getKimiComputerUseStatus(overrides)
  return { ok: true, status }
}
