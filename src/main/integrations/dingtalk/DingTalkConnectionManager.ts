import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ConnectionDefinition,
  ConnectionStatus,
  DingTalkConnectionError,
  DingTalkConnectionResult,
  DingTalkConnectionSnapshot,
  DingTalkConnectionState,
  DingTalkReadRequest,
  DingTalkReadResult
} from '../../../shared/connections'
import { DingTalkCli, DingTalkCliError, type DingTalkCliIdentity, type DingTalkCliInstallation } from './DingTalkCli'

export const DINGTALK_GUIDE_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/README_zh.md#开始使用'

const definition: ConnectionDefinition = {
  id: 'dingtalk',
  kind: 'channel',
  label: '钉钉',
  description: '授权投手在对话中搜索钉钉消息和阅读文档。',
  capabilities: ['messages.read', 'docs.read']
}

const statusByState: Record<DingTalkConnectionState, ConnectionStatus> = {
  idle: 'disconnected',
  checking: 'connecting',
  installing: 'connecting',
  authorizing: 'waiting_for_user',
  connected: 'connected',
  error: 'failed'
}

type Cli = Pick<DingTalkCli, 'find' | 'install' | 'status' | 'login' | 'currentUser' | 'searchMessages' | 'searchDocuments' | 'readDocument'>
type ConnectionOperation = 'connect' | 'check'

function exactProfile(value: unknown): value is string {
  return typeof value === 'string' && /^[^:\s\x00-\x1f\x7f]{1,256}:[^:\s\x00-\x1f\x7f]{1,256}$/.test(value)
}

function unlinkLink(file: string): void {
  try { unlinkSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function saveLink(file: string, profile: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, profile }), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    unlinkLink(temporary)
  }
}

function connectionError(error: unknown): DingTalkConnectionError {
  if (error instanceof DingTalkCliError) {
    if (error.code === 'permission-denied') return 'authorization-failed'
    if (error.code !== 'read-failed' && error.code !== 'cancelled') return error.code
  }
  return 'connection-failed'
}

const authorizationExpired = (error: unknown): boolean => error instanceof DingTalkCliError && error.code === 'not-authorized'

/** Stores the explicitly linked user/organization ID only. DWS owns authentication. */
export class DingTalkConnectionManager {
  private readonly cli: Cli
  private readonly file: string
  private profile?: string
  private identity?: DingTalkCliIdentity
  private installation: DingTalkCliInstallation | null = null
  private state: DingTalkConnectionState = 'idle'
  private lastError?: DingTalkConnectionError
  private lastConnectedAt?: number
  private listener?: (snapshot: DingTalkConnectionSnapshot) => void
  private loaded?: Promise<void>
  private initialized?: Promise<void>
  private operation?: { controller: AbortController; completion: Promise<DingTalkConnectionResult> }
  private readLifetime = new AbortController()
  private readers = 0
  private stopped = false

  constructor(options: { cli?: Cli; file?: string } = {}) {
    this.cli = options.cli ?? new DingTalkCli()
    this.file = options.file ?? path.join(app.getPath('userData'), 'dingtalk-cli-link.json')
  }

  getSnapshot(): DingTalkConnectionSnapshot {
    return {
      definition,
      state: this.state,
      status: statusByState[this.state],
      configured: this.profile !== undefined,
      cliInstalled: this.installation !== null,
      accountName: this.identity?.accountName,
      organizationName: this.identity?.organizationName,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError
    }
  }

  setStatusListener(listener: (snapshot: DingTalkConnectionSnapshot) => void): void {
    this.listener = listener
  }

  initialize(): Promise<void> {
    this.initialized ??= this.loadLink().then(async () => {
      if (this.profile && !this.stopped) await this.reconnect()
    })
    return this.initialized
  }

  connect(): Promise<DingTalkConnectionResult> {
    if (this.state === 'connected') return Promise.resolve(this.result())
    return this.start('connect')
  }

  reconnect(): Promise<DingTalkConnectionResult> {
    return this.start('check')
  }

  cancel(): DingTalkConnectionResult {
    if (this.operation) {
      this.cancelOperation()
      this.setState(this.identity ? 'connected' : this.profile ? 'error' : 'idle',
        this.profile && !this.identity ? 'not-authorized' : undefined)
    }
    return this.result()
  }

  async disconnect(): Promise<DingTalkConnectionResult> {
    this.cancelOperation()
    this.cancelReads()
    await this.loadLink()
    // A caller may have queued another action during the initial disk read.
    this.cancelOperation()
    this.cancelReads()
    this.identity = undefined
    this.lastConnectedAt = undefined
    try {
      unlinkLink(this.file)
      this.profile = undefined
      this.setState('idle')
      return this.result()
    } catch {
      this.setState('error', 'connection-failed')
      return this.result('connection-failed')
    }
  }

  shutdown(): void {
    this.stopped = true
    this.cancelOperation()
    this.cancelReads()
  }

  async read(request: DingTalkReadRequest, signal?: AbortSignal): Promise<DingTalkReadResult> {
    await this.initialize()
    const cli = this.installation
    const profile = this.identity?.profile
    if (this.stopped || !cli || !profile || this.profile !== profile || this.state !== 'connected') {
      return { ok: false, error: 'not-connected' }
    }
    if (this.readers >= 3) return { ok: false, error: 'read-failed' }
    const lifetime = this.readLifetime.signal
    const task = signal ? AbortSignal.any([signal, lifetime]) : lifetime
    this.readers++
    try {
      task.throwIfAborted()
      let data: unknown
      if (request.action === 'read_document') {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(request.documentId)) return { ok: false, error: 'invalid-input' }
        data = await this.cli.readDocument(cli, profile, request.documentId, task)
      } else {
        const query = request.query.trim()
        if (!query || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) return { ok: false, error: 'invalid-input' }
        data = request.action === 'search_messages'
          ? await this.cli.searchMessages(cli, profile, query, 20, task)
          : await this.cli.searchDocuments(cli, profile, query, 10, task)
      }
      task.throwIfAborted()
      return { ok: true, data }
    } catch (error) {
      if (lifetime.aborted) return { ok: false, error: 'not-connected' }
      if (error instanceof DingTalkCliError) {
        const code = error.code
        if (code === 'not-authorized' || code === 'organization-access-required' || code === 'cli-unavailable') {
          this.cancelReads()
          this.identity = undefined
          this.setState('error', code)
          return { ok: false, error: code }
        }
        if (code === 'network' || code === 'permission-denied') return { ok: false, error: code }
      }
      return { ok: false, error: 'read-failed' }
    } finally {
      this.readers--
    }
  }

  private loadLink(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const content = await readFile(this.file, 'utf8')
        if (content.length > 1024) return
        const value = JSON.parse(content) as { version?: unknown; profile?: unknown } | null
        if (value?.version === 1 && exactProfile(value.profile)) this.profile = value.profile
      } catch { /* An absent or unreadable app link requires an explicit login. */ }
    })()
    return this.loaded
  }

  private start(kind: ConnectionOperation): Promise<DingTalkConnectionResult> {
    if (this.stopped) return Promise.resolve(this.result('connection-failed'))
    if (this.operation) return this.operation.completion
    const controller = new AbortController()
    const completion = this.run(kind, controller.signal).finally(() => {
      if (this.operation?.controller === controller) this.operation = undefined
    })
    this.operation = { controller, completion }
    return completion
  }

  private async run(kind: ConnectionOperation, signal: AbortSignal): Promise<DingTalkConnectionResult> {
    try {
      await this.loadLink()
      signal.throwIfAborted()
      if (kind === 'check' && !this.profile) return this.result('not-authorized')
      this.setState('checking')
      let cli = await this.cli.find(signal)
      signal.throwIfAborted()
      this.installation = cli
      if (!cli && kind === 'connect') {
        this.setState('installing')
        cli = await this.cli.install(signal)
        signal.throwIfAborted()
        this.installation = cli
      }
      if (!cli) throw new DingTalkCliError('cli-unavailable')

      let identity = await this.cli.status(cli, this.profile, signal).catch(error => {
        // Some older DWS vaults return an inconclusive readonly snapshot.
        // A new explicit login can recover it via the official browser flow.
        if (kind === 'connect' && error instanceof DingTalkCliError &&
            (error.code === 'not-authorized' || error.code === 'authorization-failed')) return null
        throw error
      })
      signal.throwIfAborted()
      if (identity && (!exactProfile(identity.profile) || (this.profile && identity.profile !== this.profile))) {
        throw new DingTalkCliError('not-authorized')
      }
      if (identity) {
        try {
          await this.cli.currentUser(cli, identity.profile, signal)
        } catch (error) {
          if (kind !== 'connect' || !authorizationExpired(error)) throw error
          identity = null
        }
        signal.throwIfAborted()
      }
      if (!identity && kind === 'connect') {
        this.setState('authorizing')
        identity = await this.cli.login(cli, signal)
        signal.throwIfAborted()
        if (!identity || !exactProfile(identity.profile)) throw new DingTalkCliError('not-authorized')
        this.setState('checking')
        await this.cli.currentUser(cli, identity.profile, signal)
        signal.throwIfAborted()
      }
      if (!identity) throw new DingTalkCliError('not-authorized')
      if (this.profile !== identity.profile) {
        saveLink(this.file, identity.profile)
        this.cancelReads()
        this.profile = identity.profile
      }
      this.identity = identity
      this.lastConnectedAt = Date.now()
      this.setState('connected')
      return this.result()
    } catch (error) {
      if (signal.aborted) return this.result('connection-failed')
      const code = connectionError(error)
      this.identity = undefined
      this.setState('error', code)
      return this.result(code)
    }
  }

  private cancelOperation(): void {
    const active = this.operation
    this.operation = undefined
    active?.controller.abort()
  }

  private cancelReads(): void {
    this.readLifetime.abort()
    this.readLifetime = new AbortController()
  }

  private setState(state: DingTalkConnectionState, error?: DingTalkConnectionError): void {
    this.state = state
    this.lastError = error
    this.listener?.(this.getSnapshot())
  }

  private result(error?: DingTalkConnectionError): DingTalkConnectionResult {
    return { ok: !error, snapshot: this.getSnapshot(), ...(error ? { error } : {}) }
  }
}

export const dingTalkConnectionManager = new DingTalkConnectionManager()
