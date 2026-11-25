import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawnCommand } from '../../command'
import { executableSearchDirs } from '../../omp/OmpCapabilities'
import { getWorkspaceOperation, parseWorkspaceArgs, workspaceArguments, workspaceCatalogVersion, projectWorkspaceResult } from './workspaceOperations'
import { parseNode } from './requests'

const DWS_TAG = 'v1.0.69'
const RELEASE = 'DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/' + DWS_TAG
const DOWNLOAD_ROOTS = ['https://github.com/' + RELEASE, 'https://gitee.com/' + RELEASE.toLowerCase()]
const DOWNLOAD_HOSTS = new Set([
  'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
  'gitee.com', 'foruda.gitee.com'
])
const MAX_OUTPUT_BYTES = 1024 * 1024

interface Asset {
  name: string
  size: number
  sha256: string
}

// Official GitHub v1.0.69 release metadata. The same digest gates both mirrors.
const ASSETS: Record<string, Asset> = {
  'darwin-arm64': {
    name: 'dws-darwin-arm64.tar.gz',
    size: 18_033_619,
    sha256: 'b7dbea8653bcdaa78934f7e632ed8cb7835ba1647b58ddc9b09c6981fc5560d8'
  },
  'darwin-x64': {
    name: 'dws-darwin-amd64.tar.gz',
    size: 19_815_434,
    sha256: '4ab7511b7481531195a0d2d6cb16df9546e9513f3d375a165fd1afc892b0e559'
  },
  'win32-x64': {
    name: 'dws-windows-amd64.zip',
    size: 25_572_904,
    sha256: '9684b525e836943f41ea6ca03404b2221a25c6ebe63f569487bd06b732574b48'
  },
  'win32-arm64': {
    name: 'dws-windows-arm64.zip',
    size: 19_172_306,
    sha256: '770372e261b2892e148fa7e8ecf129f20bda760016ca5b03facef03ba83d7ae3'
  },
  'linux-x64': {
    name: 'dws-linux-amd64.tar.gz',
    size: 20_355_776,
    sha256: '567257be28c1ccce4f424fc92969f9c21dd15ed600a86c252adbc35821bf7c4a'
  },
  'linux-arm64': {
    name: 'dws-linux-arm64.tar.gz',
    size: 19_096_496,
    sha256: '4a8fdb369527abbb4bcf90ebf79c5e329a2021c2608491f71a610ef3a67a9797'
  }
}

export type DingTalkCliErrorCode =
  | 'cli-unavailable'
  | 'install-failed'
  | 'authorization-failed'
  | 'organization-access-required'
  | 'network'
  | 'not-authorized'
  | 'permission-denied'
  | 'read-failed'
  | 'write-failed'
  | 'write-outcome-unknown'
  | 'cancelled'

export class DingTalkCliError extends Error {
  constructor(readonly code: DingTalkCliErrorCode, readonly nodeId?: string) {
    super(code)
    this.name = 'DingTalkCliError'
  }
}

export interface DingTalkCliInstallation {
  path: string
  version: string
  source: 'managed' | 'external'
}

export interface DingTalkCliIdentity {
  /** Exact identity selector used for subsequent read commands. */
  profile: string
  accountName?: string
  organizationName?: string
}

interface DocumentWriteReceipt {
  nodeId: string
  mentionTargetsUnverified?: true
}

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

type RunProcess = (
  executable: string,
  args: string[],
  directory: string,
  timeout: number,
  signal?: AbortSignal,
  io?: number | { input: string }
) => Promise<ProcessResult>

interface DingTalkCliOptions {
  directory?: string
  searchDirectories?: () => string[]
  request?: typeof fetch
  run?: RunProcess
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DingTalkCliError('cancelled')
}

function environment(): NodeJS.ProcessEnv {
  const names = new Set([
    'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'
  ])
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toUpperCase()))),
    PATH: executableSearchDirs().join(path.delimiter)
  }
}

const runProcess: RunProcess = (executable, args, directory, timeout, signal, io) => new Promise((resolve, reject) => {
  checkCancelled(signal)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const child = spawnCommand(executable, args, {
    cwd: directory,
    env: environment(),
    windowsHide: true,
    stdio: [typeof io === 'object' ? 'pipe' : 'ignore', typeof io === 'number' ? io : 'pipe', 'pipe']
  })
  let size = 0
  let failure: DingTalkCliError | undefined
  const kill = (error: DingTalkCliError) => {
    failure ??= error
    try { child.kill('SIGKILL') } catch { /* the process has already exited */ }
  }
  const cancel = () => kill(new DingTalkCliError('cancelled'))
  const timer = setTimeout(() => kill(new DingTalkCliError('network')), timeout)
  const capture = (destination: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_OUTPUT_BYTES) {
      if (!failure) kill(new DingTalkCliError('read-failed'))
      return
    }
    destination.push(chunk)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  child.stdout?.on('data', capture(stdout))
  child.stderr?.on('data', capture(stderr))
  let inputFailed = false
  if (typeof io === 'object' && child.stdin) {
    // A CLI that rejects arguments may close stdin before reading the document.
    child.stdin.on('error', () => { inputFailed = true })
    child.stdin.end(io.input, 'utf8')
  }
  child.on('error', () => { failure ??= new DingTalkCliError('cli-unavailable') })
  child.once('close', code => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (failure) { reject(failure); return }
    if (inputFailed && code === 0) { reject(new DingTalkCliError('write-outcome-unknown')); return }
    resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
  })
})

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 160) || undefined
}

const exactProfile = /^[A-Za-z0-9_.@=-]{1,256}:[A-Za-z0-9_.@=-]{1,256}$/
const nodeIdPattern = /^[A-Za-z0-9_-]{1,256}$/

function safeNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && nodeIdPattern.test(value) ? value : undefined
}

function identity(value: Record<string, unknown>, fallback: DingTalkCliErrorCode): DingTalkCliIdentity {
  const { corp_id, user_id } = value
  const profile = typeof corp_id === 'string' && typeof user_id === 'string' ? corp_id + ':' + user_id : ''
  if (!exactProfile.test(profile)) throw new DingTalkCliError(fallback)
  return {
    profile,
    accountName: displayName(value.user_name),
    organizationName: displayName(value.corp_name)
  }
}

function readError(result: ProcessResult, fallback: DingTalkCliErrorCode): DingTalkCliError {
  const detail = result.stdout + '\n' + result.stderr
  if (/org[._-]?(?:no[._-]?access|cli[._-]?access|not[._-]?enabled)|cli.{0,12}access.{0,24}(?:disabled|not enabled)|管理员.{0,20}(?:开通|审批)|组织.{0,16}(?:未开通|未开启|未启用)|请申请.{0,12}(?:权限|访问)/i.test(detail)) {
    return new DingTalkCliError('organization-access-required')
  }
  if (/\b(?:Unauthorized|not_authorized|NOT_LOGGED_IN|token_expired|invalid_token|AUTH_REQUIRED)\b|未登录|授权已过期/i.test(detail)) {
    return new DingTalkCliError('not-authorized')
  }
  if (/\b(?:forbidden|PERMISSION_DENIED|access_denied)\b|权限不足|无权访问|没有权限/i.test(detail)) {
    return new DingTalkCliError('permission-denied')
  }
  if (/connection refused|dial tcp|i\/o timeout|network error|certificate verify|connection reset|temporary failure|no such host|network timeout|context deadline exceeded/i.test(detail)) {
    return new DingTalkCliError('network')
  }
  return new DingTalkCliError(fallback)
}

function parseResult(result: ProcessResult, fallback: DingTalkCliErrorCode): unknown {
  if (result.exitCode !== 0) throw readError(result, fallback)
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch { throw readError(result, fallback) }
  const envelope = record(parsed)
  if (envelope?.success === false || envelope?.isError === true || envelope?.error) throw readError(result, fallback)
  return parsed
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(text)) } catch { return undefined }
}

function writeReceipt(result: ProcessResult, target?: string, mode: 'append' | 'overwrite' = 'append'): DocumentWriteReceipt {
  const response = jsonObject(result.stdout)
  const error = record(response?.error) ?? record(jsonObject(result.stderr)?.error)
  const details = record(error?.details)
  const data = record(response?.data)
  const nodeId = safeNodeId(data?.nodeId)
  const recoveryId = target ?? nodeId ?? safeNodeId(record(details?.data)?.nodeId) ?? safeNodeId(details?.nodeId)
  const unknown = new DingTalkCliError('write-outcome-unknown', recoveryId)
  if (error) {
    // A later chunk or the verification read can fail even after creation succeeded.
    if (error.execution_started === true || details?.status === 'partial_success' || details?.status === 'unknown') throw unknown
    if (error.execution_started === false || error.category === 'validation' || error.category === 'auth') {
      if (error.reason === 'authentication_required') throw new DingTalkCliError('not-authorized')
      const failure = readError(result, 'write-failed')
      if (failure.code === 'network') throw unknown
      throw failure
    }
    throw unknown
  }
  const operation = target ? 'doc.update' : 'doc.create'
  if (result.exitCode !== 0 || response?.contractVersion !== 'doc.operation.v1' || response.operation !== operation
      || response.ok !== true || response.complete !== true || response.status !== 'success' || data?.executed === false
      || !nodeId || (target && (nodeId !== target || data?.mode !== mode))) throw unknown
  // DWS verifies all written content but cannot resolve the recipient of an @mention from readback.
  const unverified = data?.unverified
  const mentionOnly = data?.verified === false && data.verificationScope === 'partial'
    && Array.isArray(unverified) && unverified.length === 1 && unverified[0] === 'mention_targets'
  if (data?.verified !== true && !mentionOnly) throw unknown
  return mentionOnly ? { nodeId, mentionTargetsUnverified: true } : { nodeId }
}

const emptyPermissionReceipts = new Set(['doc.permission.remove', 'doc.permission.update', 'wiki.member.remove', 'wiki.member.update'])
const fileOnlyReceipts = new Set(['mail.attachment.download', 'sheet.export-csv', 'doc.download'])

function workspaceReceipt(result: ProcessResult, id: string, privatePath?: string): unknown {
  const response = jsonObject(result.stdout)
  const details = record(response?.error) ?? record(jsonObject(result.stderr)?.error)
  if (details?.execution_started === false) {
    if (details.reason === 'authentication_required') throw new DingTalkCliError('not-authorized')
    throw readError(result, 'write-failed')
  }
  if (result.exitCode !== 0 || details) throw new DingTalkCliError('write-outcome-unknown')
  // These commands print human status only. The native save helper separately verifies
  // that this invocation produced the expected regular file before publishing it.
  if (!response && fileOnlyReceipts.has(id) && !/^\s*[{[]/.test(result.stdout)) return { saved: true }
  if (!response) throw new DingTalkCliError('write-outcome-unknown')
  if (emptyPermissionReceipts.has(id) && Object.keys(response).length === 0) return { success: true }
  // DWS 1.0.69 emits both its unified outcome and older service-specific success receipts.
  const unified = response.outcome !== undefined
  const data = record(response.data)
  const docReceipt = response.contractVersion === 'doc.operation.v1' && response.ok === true && response.complete === true
    && response.status === 'success' && data?.verified === true
  const uploadReceipt = (id === 'drive.upload' || id === 'doc.upload') && !!safeNodeId(response.dentryUuid)
  const acknowledged = unified ? response.ok === true && response.outcome === 'success' : response.success === true || docReceipt || uploadReceipt
  const states = [response, data, record(response.result), record(data?.result)]
  if (Array.isArray(response.steps)) states.push(...response.steps.slice(0, 1024).map(record))
  const uncertain = states.some(item => item && (
    item.ok === false || item.success === false || item.isError === true || item.error || item.complete === false
    || item.executed === false || item.verified === false || item.dry_run === true || item.dryRun === true
    || (Array.isArray(item.errors) && item.errors.length > 0) || (typeof item.failedCount === 'number' && item.failedCount > 0)
    || (typeof item.outcome === 'string' && item.outcome !== 'success')
    || (typeof item.status === 'string' && /pending|unknown|partial|fail|error|cancel|timeout|planned|processing|queued/i.test(item.status))
  ))
  if (!acknowledged || uncertain) throw new DingTalkCliError('write-outcome-unknown')
  return projectWorkspaceResult(response, privatePath)
}

/** Use the desktop's configured proxies and keep redirects under Main's allowlist. */
const requestWithSystemProxy: typeof fetch = (location, options) => new Promise((resolve, reject) => {
  const signal = options?.signal
  const request = net.request({ url: String(location), redirect: 'manual', credentials: 'omit' })
  let stream: Readable | undefined
  const abort = () => {
    const error = new DingTalkCliError('network')
    stream?.destroy(error)
    request.abort()
    reject(error)
  }
  request.once('close', () => signal?.removeEventListener('abort', abort))
  request.once('error', () => reject(new DingTalkCliError('network')))
  request.once('redirect', (status, _method, location) => {
    request.abort()
    resolve(new Response(null, { status, headers: { Location: location } }))
  })
  request.once('response', response => {
    const status = response.statusCode
    if (status !== 200) {
      request.abort()
      resolve(new Response(null, { status }))
      return
    }
    // Electron's IncomingMessage implements a Node Readable at runtime.
    stream = response as unknown as Readable
    resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status }))
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  else request.end()
})

async function requestArchive(request: typeof fetch, location: string, signal: AbortSignal): Promise<Response> {
  let url = new URL(location)
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new DingTalkCliError('install-failed')
    }
    const headers = new AbortController()
    const timer = setTimeout(() => headers.abort(), 12_000)
    let response: Response
    try {
      response = await request(url, {
        signal: AbortSignal.any([signal, headers.signal]),
        credentials: 'omit',
        redirect: 'manual'
      })
    } finally {
      clearTimeout(timer)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const next = response.headers.get('location')
    await response.body?.cancel()
    if (!next) throw new DingTalkCliError('install-failed')
    url = new URL(next, url)
  }
  throw new DingTalkCliError('install-failed')
}

async function downloadArchive(request: typeof fetch, base: string, asset: Asset, destination: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(90_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await requestArchive(request, base + '/' + asset.name, combined)
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new DingTalkCliError('network')
  }

  const reader = response.body.getReader()
  const file = await open(destination, 'w', 0o600).catch(async error => {
    await reader.cancel().catch(() => undefined)
    throw error
  })
  const hash = createHash('sha256')
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > asset.size) throw new DingTalkCliError('install-failed')
      hash.update(chunk.value)
      await file.writeFile(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    await file.close()
  }
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new DingTalkCliError('install-failed')
}

function binaryVersion(result: ProcessResult): string | undefined {
  if (result.exitCode !== 0) return undefined
  const parsed = /^dws version (v(\d+)\.(\d+)\.(\d+))(?=\s|$)/.exec(result.stdout)
  if (!parsed) return undefined
  const [, version, major, minor, patch] = parsed
  if (Number(major) === 0 || (Number(major) === 1 && Number(minor) === 0 && Number(patch) < 69)) return undefined
  return version
}

export class DingTalkCli {
  private readonly run: RunProcess
  private readonly request: typeof fetch

  constructor(private readonly options: DingTalkCliOptions = {}) {
    this.run = options.run ?? runProcess
    this.request = options.request ?? requestWithSystemProxy
  }

  private get directory(): string {
    return this.options.directory ?? path.join(app.getPath('userData'), 'dingtalk-cli', DWS_TAG)
  }

  private get binaryName(): string {
    return process.platform === 'win32' ? 'dws.exe' : 'dws'
  }

  async find(signal?: AbortSignal, requiredVersion?: string): Promise<DingTalkCliInstallation | null> {
    const managed = path.join(this.directory, this.binaryName)
    const candidates = this.options.searchDirectories?.() ?? [
      ...executableSearchDirs(),
      path.join(homedir(), '.local', 'bin')
    ]
    for (const executable of new Set([managed, ...candidates.filter(entry => path.isAbsolute(entry)).map(dir => path.join(dir, this.binaryName))])) {
      checkCancelled(signal)
      try {
        if (!(await stat(executable)).isFile()) continue
        await access(executable, constants.X_OK)
        const version = binaryVersion(await this.run(executable, ['--version'], path.dirname(executable), 8_000, signal))
        const source = executable === managed ? 'managed' : 'external'
        if (version && (!requiredVersion || version === requiredVersion) && (source === 'external' || version === DWS_TAG)) return { path: executable, version, source }
      } catch (error) {
        if (error instanceof DingTalkCliError && error.code === 'cancelled') throw error
      }
    }
    checkCancelled(signal)
    return null
  }

  async install(signal?: AbortSignal): Promise<DingTalkCliInstallation> {
    checkCancelled(signal)
    const asset = ASSETS[process.platform + '-' + process.arch]
    if (!asset) throw new DingTalkCliError('cli-unavailable')
    let staging: string | undefined
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      staging = await mkdtemp(path.join(this.directory, 'install-'))
      const archive = path.join(staging, asset.name)
      await this.fetchReleaseAsset(asset, archive, signal)
      checkCancelled(signal)

      // Extract the one known entry to a fresh file, without unpacking any archive paths.
      const binary = path.join(staging, this.binaryName)
      const file = await open(binary, 'wx', 0o700)
      try {
        const windows = process.platform === 'win32'
        const tar = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
        if (!path.isAbsolute(tar)) throw new DingTalkCliError('install-failed')
        const entry = windows ? this.binaryName : './' + this.binaryName
        const extracted = await this.run(tar, ['-xOf', archive, entry], staging, 30_000, signal, file.fd)
        if (extracted.exitCode !== 0) throw new DingTalkCliError('install-failed')
      } finally {
        await file.close()
      }
      if (process.platform !== 'win32') await chmod(binary, 0o700)
      const version = binaryVersion(await this.run(binary, ['--version'], staging, 12_000, signal))
      if (version !== DWS_TAG) throw new DingTalkCliError('install-failed')
      checkCancelled(signal)
      const installed = path.join(this.directory, this.binaryName)
      await rename(binary, installed)
      return { path: installed, version, source: 'managed' }
    } catch (error) {
      checkCancelled(signal)
      if (error instanceof DingTalkCliError && ['cancelled', 'network'].includes(error.code)) throw error
      throw new DingTalkCliError('install-failed')
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async fetchReleaseAsset(asset: Asset, destination: string, signal?: AbortSignal): Promise<void> {
    let integrityFailure = false
    for (const base of DOWNLOAD_ROOTS) {
      checkCancelled(signal)
      try {
        await downloadArchive(this.request, base, asset, destination, signal)
        return
      } catch (error) {
        checkCancelled(signal)
        integrityFailure ||= error instanceof DingTalkCliError && error.code === 'install-failed'
      }
    }
    throw new DingTalkCliError(integrityFailure ? 'install-failed' : 'network')
  }

  async status(cli: DingTalkCliInstallation, profile?: string, signal?: AbortSignal): Promise<DingTalkCliIdentity | null> {
    const args = ['auth', 'status', '--readonly', '--format=json']
    if (profile !== undefined) args.push(this.profileArgument(profile))
    const value = record(parseResult(await this.invoke(cli, args, 12_000, signal), 'authorization-failed'))
    if (value?.success !== true || typeof value.authenticated !== 'boolean') throw new DingTalkCliError('authorization-failed')
    if (value.reason) throw new DingTalkCliError('authorization-failed')
    if (!value.authenticated) return null
    const selected = identity(value, 'authorization-failed')
    if (profile !== undefined && selected.profile !== profile) throw new DingTalkCliError('not-authorized')
    return selected
  }

  async login(cli: DingTalkCliInstallation, signal?: AbortSignal): Promise<DingTalkCliIdentity | null> {
    // Explicit JSON mode keeps the official browser OAuth flow and disables post-login terminal menus.
    const value = record(parseResult(await this.invoke(cli, ['auth', 'login', '--format=json'], 5 * 60_000, signal), 'authorization-failed'))
    if (value?.success !== true) throw new DingTalkCliError('authorization-failed')
    return identity(value, 'authorization-failed')
  }

  currentUser(cli: DingTalkCliInstallation, profile: string, signal?: AbortSignal): Promise<unknown> {
    return this.read(cli, profile, ['contact', 'user', 'get-self'], signal)
  }

  searchMessages(cli: DingTalkCliInstallation, profile: string, query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    return this.read(cli, profile, ['chat', '+search-msg', this.queryArgument(query), this.limitArgument(limit, 20), '--no-enrich'], signal)
  }

  searchDocuments(cli: DingTalkCliInstallation, profile: string, query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    return this.read(cli, profile, ['drive', 'search', this.queryArgument(query), '--target=file', '--extensions=adoc', this.limitArgument(limit, 10)], signal)
  }

  readDocument(cli: DingTalkCliInstallation, profile: string, documentId: string, signal?: AbortSignal): Promise<unknown> {
    if (!safeNodeId(documentId)) throw new DingTalkCliError('read-failed')
    return this.read(cli, profile, ['doc', 'read', '--node=' + documentId], signal)
  }

  async workspaceOperation(cli: DingTalkCliInstallation, profile: string, id: string, input: Record<string, unknown>, signal?: AbortSignal, canDispatch?: () => boolean): Promise<unknown> {
    checkCancelled(signal)
    const operation = getWorkspaceOperation(id)
    const args = parseWorkspaceArgs(id, input)
    if (!operation || !args) throw new DingTalkCliError(operation?.effect === 'read' || !operation ? 'read-failed' : 'write-failed')
    const profileFlag = this.profileArgument(profile)
    const write = operation.effect !== 'read'
    if (write && canDispatch && !canDispatch()) throw new DingTalkCliError('permission-denied')
    const requiredVersion = 'v' + workspaceCatalogVersion
    const pinned = cli.version === requiredVersion ? cli : (await this.find(signal, requiredVersion) ?? await this.install(signal))
    if (pinned.version !== requiredVersion || !path.isAbsolute(pinned.path) || /\.(cmd|bat)$/i.test(pinned.path)) throw new DingTalkCliError('cli-unavailable')
    if (id === 'doc.update') {
      const node = parseNode(args.node)
      if (!node || typeof args.content !== 'string' || operation.stdin !== 'content') throw new DingTalkCliError('write-failed')
      if (canDispatch && !canDispatch()) throw new DingTalkCliError('permission-denied')
      const receipt = await this.write(pinned, profile, workspaceArguments(operation, { ...args, node }), args.content, signal, node, 'overwrite')
      return { ...receipt, url: 'https://alidocs.dingtalk.com/i/nodes/' + receipt.nodeId }
    }
    const argv = [profileFlag, ...workspaceArguments(operation, args), '--format=json', write ? '--timeout=30' : '--timeout=25']
    if (operation.transfer) {
      const flag = operation.transfer
      const { withDingTalkTransfer } = await import('./workspaceFileTransfer')
      try {
        return await withDingTalkTransfer(id, flag, signal, async filePath => {
          const data = await this.dispatchWorkspace(pinned, [...argv, '--' + flag + '=' + filePath], operation, signal, canDispatch, filePath)
          return flag === 'output' ? { saved: true } : data
        }, canDispatch)
      } catch (error) {
        if (error instanceof DingTalkCliError) throw error
        checkCancelled(signal)
        throw new DingTalkCliError('write-failed')
      }
    }
    return this.dispatchWorkspace(pinned, argv, operation, signal, canDispatch)
  }

  private async dispatchWorkspace(cli: DingTalkCliInstallation, argv: string[], operation: NonNullable<ReturnType<typeof getWorkspaceOperation>>,
    signal?: AbortSignal, canDispatch?: () => boolean, privatePath?: string): Promise<unknown> {
    const write = operation.effect !== 'read'
    checkCancelled(signal)
    if (write && canDispatch && !canDispatch()) throw new DingTalkCliError('permission-denied')
    let result: ProcessResult
    try {
      result = await this.run(cli.path, argv, path.dirname(cli.path), write ? 150_000 : 35_000, signal)
      checkCancelled(signal)
    } catch (error) {
      if (!write) throw error instanceof DingTalkCliError ? error : new DingTalkCliError('read-failed')
      if (error instanceof DingTalkCliError && error.code === 'cli-unavailable') throw error
      throw new DingTalkCliError('write-outcome-unknown')
    }
    if (write) return workspaceReceipt(result, operation.id, privatePath)
    const data = parseResult(result, 'read-failed')
    const envelope = record(data)
    if (envelope?.ok === false || envelope?.outcome === 'failure') throw readError(result, 'read-failed')
    return projectWorkspaceResult(data)
  }

  async createDocument(cli: DingTalkCliInstallation, profile: string, title: string, content?: string, folderId?: string, signal?: AbortSignal): Promise<DocumentWriteReceipt> {
    if (!title.trim() || title.length > 200 || /[\x00-\x1f\x7f]/.test(title) || (folderId !== undefined && !safeNodeId(folderId))) {
      throw new DingTalkCliError('write-failed')
    }
    const args = ['doc', '+create', '--name=' + title]
    if (folderId) args.push('--folder=' + folderId)
    if (content !== undefined) args.push('--content=-')
    return this.write(cli, profile, args, content ?? '', signal)
  }

  async appendDocument(cli: DingTalkCliInstallation, profile: string, documentId: string, content: string, signal?: AbortSignal): Promise<DocumentWriteReceipt> {
    if (!safeNodeId(documentId) || !content.trim()) throw new DingTalkCliError('write-failed')
    // The desktop has authorized this write. Keep the update action fixed to append.
    return this.write(cli, profile, ['doc', '+update', '--node=' + documentId, '--command=append', '--content=-', '--yes'], content, signal, documentId)
  }

  private async write(cli: DingTalkCliInstallation, profile: string, args: string[], content: string, signal?: AbortSignal, target?: string, mode?: 'append' | 'overwrite'): Promise<DocumentWriteReceipt> {
    checkCancelled(signal)
    if (!path.isAbsolute(cli.path)) throw new DingTalkCliError('cli-unavailable')
    if (content.length > 64_000 || content.includes('\0')) throw new DingTalkCliError('write-failed')
    const argv = [this.profileArgument(profile), ...args, '--format=json', '--timeout=30']
    let result: ProcessResult
    try {
      result = await this.run(cli.path, argv, path.dirname(cli.path), 150_000, signal, { input: content })
      checkCancelled(signal)
    } catch (error) {
      if (error instanceof DingTalkCliError && error.code === 'cli-unavailable') throw error
      // Once dispatched, a timeout, interruption or lost response cannot prove the write failed.
      throw new DingTalkCliError('write-outcome-unknown', target)
    }
    return writeReceipt(result, target, mode)
  }

  private profileArgument(profile: string): string {
    if (!exactProfile.test(profile)) throw new DingTalkCliError('not-authorized')
    return '--profile=' + profile
  }

  private queryArgument(query: string): string {
    if (!query.trim() || query.length > 512 || /[\x00-\x1f\x7f]/.test(query)) throw new DingTalkCliError('read-failed')
    return '--query=' + query
  }

  private limitArgument(limit: number, max: number): string {
    if (!Number.isFinite(limit)) throw new DingTalkCliError('read-failed')
    return '--limit=' + Math.max(1, Math.min(Math.floor(limit), max))
  }

  private async read(cli: DingTalkCliInstallation, profile: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    const result = await this.invoke(cli, [this.profileArgument(profile), ...args, '--format=json', '--timeout=25'], 35_000, signal)
    return parseResult(result, 'read-failed')
  }

  private async invoke(cli: DingTalkCliInstallation, args: string[], timeout: number, signal?: AbortSignal): Promise<ProcessResult> {
    checkCancelled(signal)
    if (!path.isAbsolute(cli.path)) throw new DingTalkCliError('cli-unavailable')
    return this.run(cli.path, args, path.dirname(cli.path), timeout, signal)
  }
}
