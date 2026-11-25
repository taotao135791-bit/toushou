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
  DingTalkToolRequest,
  DingTalkToolResult
} from '../../../shared/connections'
import { DingTalkCli, DingTalkCliError, type DingTalkCliIdentity, type DingTalkCliInstallation } from './DingTalkCli'
import { isDingTalkNodeId, isDingTalkWrite, parseDingTalkRequest } from './requests'
import { listWorkspaceOperations } from './workspaceOperations'

export const DINGTALK_GUIDE_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/README_zh.md#开始使用'

const definition: ConnectionDefinition = {
  id: 'dingtalk',
  kind: 'channel',
  label: '钉钉',
  description: '在当前钉钉账号权限内操作在线表格、文档和其他办公应用，查询聊天消息。',
  capabilities: ['messages.read', 'docs.read', 'docs.create', 'docs.append', 'workspace.catalog', 'workspace.read', 'workspace.write']
}

const statusByState: Record<DingTalkConnectionState, ConnectionStatus> = {
  idle: 'disconnected',
  checking: 'connecting',
  installing: 'connecting',
  authorizing: 'waiting_for_user',
  connected: 'connected',
  error: 'failed'
}

type Cli = Pick<DingTalkCli, 'find' | 'install' | 'status' | 'login' | 'currentUser' | 'searchMessages' | 'searchDocuments' | 'readDocument' | 'createDocument' | 'appendDocument' | 'workspaceOperation'>
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
    switch (error.code) {
      case 'cli-unavailable': case 'install-failed': case 'authorization-failed':
      case 'organization-access-required': case 'network': case 'not-authorized':
        return error.code
    }
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
  private bindingLifetime = new AbortController()
  private activeRequests = 0
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
    this.cancelRequests()
    await this.loadLink()
    // A caller may have queued another action during the initial disk read.
    this.cancelOperation()
    this.cancelRequests()
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
    this.cancelRequests()
  }

  connectedLifetime(): AbortSignal | null {
    return this.state === 'connected' && !this.stopped ? this.bindingLifetime.signal : null
  }

  async execute(input: DingTalkToolRequest, signal?: AbortSignal, canWrite?: () => boolean): Promise<DingTalkToolResult> {
    const request = parseDingTalkRequest(input)
    if (!request) return { ok: false, error: 'invalid-input' }
    if (request.action === 'workspace_catalog') {
      const data = listWorkspaceOperations(request.service, request.operation, request.cursor)
      return data ? { ok: true, data } : { ok: false, error: 'invalid-input' }
    }
    await this.initialize()
    const cli = this.installation
    const profile = this.identity?.profile
    const lifetime = this.connectedLifetime()
    if (!lifetime || !cli || !profile || this.profile !== profile) return { ok: false, error: 'not-connected' }
    const write = isDingTalkWrite(request)
    if (this.activeRequests >= 3) return { ok: false, error: write ? 'write-failed' : 'read-failed' }
    const task = signal ? AbortSignal.any([signal, lifetime]) : lifetime
    this.activeRequests++
    try {
      if (write) {
        // Recheck the initiating session and approval after asynchronous connection setup.
        if (task.aborted || !canWrite?.()) return { ok: false, error: 'write-forbidden' }
        if (request.action === 'workspace_write') {
          const data = await this.cli.workspaceOperation(cli, profile, request.operation, request.args, task, canWrite)
          return task.aborted ? { ok: false, error: 'write-outcome-unknown' } : { ok: true, data }
        }
        const result = request.action === 'create_document'
          ? await this.cli.createDocument(cli, profile, request.title, request.content, request.folderId, task)
          : await this.cli.appendDocument(cli, profile, request.documentId, request.content, task)
        if (task.aborted || !isDingTalkNodeId(result?.nodeId)) return { ok: false, error: 'write-outcome-unknown' }
        return { ok: true, data: {
          nodeId: result.nodeId, url: 'https://alidocs.dingtalk.com/i/nodes/' + result.nodeId,
          ...(result.mentionTargetsUnverified ? { mentionTargetsUnverified: true, note: '正文已写入，钉钉未能核实文中 @ 的具体对象。' } : {})
        } }
      }
      task.throwIfAborted()
      let data: unknown
      if (request.action === 'workspace_read') data = await this.cli.workspaceOperation(cli, profile, request.operation, request.args, task)
      else if (request.action === 'read_document') data = await this.cli.readDocument(cli, profile, request.documentId, task)
      else if (request.action === 'search_messages') data = await this.cli.searchMessages(cli, profile, request.query, 20, task)
      else data = await this.cli.searchDocuments(cli, profile, request.query, 10, task)
      task.throwIfAborted()
      return { ok: true, data }
    } catch (error) {
      if (task.aborted && write) return { ok: false, error: 'write-outcome-unknown' }
      if (lifetime.aborted) return { ok: false, error: 'not-connected' }
      if (error instanceof DingTalkCliError) {
        const code = error.code
        if (code === 'not-authorized' || code === 'organization-access-required' || code === 'cli-unavailable') {
          this.cancelRequests()
          this.identity = undefined
          this.setState('error', code)
          return { ok: false, error: code }
        }
        if (code === 'write-outcome-unknown' || (code === 'network' && write)) {
          const nodeId = error.nodeId ?? (request.action === 'append_document' ? request.documentId : undefined)
          return { ok: false, error: 'write-outcome-unknown', ...(isDingTalkNodeId(nodeId) ? { nodeId } : {}) }
        }
        if (code === 'network' || code === 'permission-denied' || code === 'write-failed' || code === 'cancelled') return { ok: false, error: code }
      }
      return { ok: false, error: write ? 'write-outcome-unknown' : 'read-failed' }
    } finally {
      this.activeRequests--
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
        this.cancelRequests()
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

  private cancelRequests(): void {
    this.bindingLifetime.abort()
    this.bindingLifetime = new AbortController()
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
