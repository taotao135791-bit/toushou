import { app } from 'electron'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawnCommand } from '../../command'
import { executableSearchDirs } from '../../omp/OmpCapabilities'

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
  | 'cancelled'

export class DingTalkCliError extends Error {
  constructor(readonly code: DingTalkCliErrorCode) {
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
  outputFd?: number
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

const runProcess: RunProcess = (executable, args, directory, timeout, signal, outputFd) => new Promise((resolve, reject) => {
  checkCancelled(signal)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const child = spawnCommand(executable, args, {
    cwd: directory,
    env: environment(),
    windowsHide: true,
    stdio: ['ignore', outputFd ?? 'pipe', 'pipe']
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
  child.on('error', () => { failure ??= new DingTalkCliError('cli-unavailable') })
  child.once('close', code => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (failure) { reject(failure); return }
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
    this.request = options.request ?? fetch
  }

  private get directory(): string {
    return this.options.directory ?? path.join(app.getPath('userData'), 'dingtalk-cli', DWS_TAG)
  }

  private get binaryName(): string {
    return process.platform === 'win32' ? 'dws.exe' : 'dws'
  }

  async find(signal?: AbortSignal): Promise<DingTalkCliInstallation | null> {
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
        if (version && (source === 'external' || version === DWS_TAG)) return { path: executable, version, source }
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
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(documentId)) throw new DingTalkCliError('read-failed')
    return this.read(cli, profile, ['doc', 'read', '--node=' + documentId], signal)
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
