import { app, BrowserWindow, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  ConnectionDefinition,
  FeishuCapability,
  FeishuConnectState,
  FeishuConnectionResult,
  FeishuConnectionSnapshot,
  FeishuManualCredentials,
  FeishuRegistrationView,
  FeishuToolRequest,
  FeishuToolResult,
  ConnectionStatus,
  LarkBrand,
  FeishuOAuthAuthorizationView,
  FeishuOAuthBeginResult
} from '../../../shared/connections'
import { SessionEvent } from '../../../shared/types'
import { createSession, getSession, getSessionState, killSession, resumeSession, sendMessage } from '../../omp'
import { getStore } from '../../store'
import { FeishuChannel } from './FeishuChannel'
import { FeishuCredentialStore, FeishuStoredCredentials, maskSecret } from './FeishuCredentialStore'
import { PersonalAgentRegistrationProvider, RegistrationSession } from './FeishuAppRegistration'
import { FeishuOAuthManager } from './FeishuOAuthManager'
import { FeishuSessionRouter } from './FeishuSessionRouter'
import { FeishuToolRegistry } from './FeishuToolRegistry'

const FEISHU_DEFINITION: ConnectionDefinition = {
  id: 'feishu',
  kind: 'channel',
  label: '飞书',
  description: '把投手接入你的飞书工作空间。',
  capabilities: ['messaging', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write', 'bitable.read', 'bitable.write']
}

export class FeishuConnectionManager {
  private readonly credentialStore = new FeishuCredentialStore()
  private readonly registrationProvider = new PersonalAgentRegistrationProvider()
  private readonly oauthManager = new FeishuOAuthManager(this.credentialStore)
  private readonly workspacePath = path.join(app.getPath('documents'), '投手工作区')
  private readonly routesFile = path.join(app.getPath('userData'), 'feishu-routes.json')
  private readonly router: FeishuSessionRouter
  private readonly tools: FeishuToolRegistry
  private channel: FeishuChannel | null = null
  private credentials: FeishuStoredCredentials | null = null
  private registration: RegistrationSession | null = null
  private registrationAbort: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private progressMessageKeys = new Set<string>()
  private sessionEventSink: ((event: SessionEvent) => void) | null = null
  private state: FeishuConnectState = 'idle'
  private lastError: string | undefined
  private lastConnectedAt: number | undefined
  private lastMessageAt: number | undefined
  private lastReconnectAt: number | undefined
  private authorizedCapabilities: FeishuCapability[] = ['messaging']
  private initialized = false

  constructor() {
    this.router = new FeishuSessionRouter({
      workspacePath: this.workspacePath,
      routesFile: this.routesFile,
      createSession: (cwd, _onEvent, opts) => createSession(cwd, (event) => this.handleOmpEvent(event), opts),
      sendMessage,
      getSession,
      getSessionState,
      resumeSession: async (cwd, _onEvent, filePath) => {
        const result = await resumeSession(cwd, (event) => this.handleOmpEvent(event), filePath)
        return result ? { session: result.session, messages: result.messages } : null
      },
      killSession,
      onReply: (route, content, sourceMessageId) => this.sendReply(route.chatId, content, sourceMessageId, Boolean(route.rootId || route.threadId)),
      onProgress: (route) => this.sendProgress(route.chatId, route.lastMessageId, Boolean(route.rootId || route.threadId)),
      ownerOpenId: undefined
    })
    this.tools = new FeishuToolRegistry(
      () => this.channel,
      (capability) => this.authorizedCapabilities.includes(capability),
      (capability) => this.oauthManager.accessTokenFor(capability)
    )
  }

  setSessionEventSink(sink: (event: SessionEvent) => void): void {
    this.sessionEventSink = sink
  }

  /** Non-blocking startup recovery for stored credentials. */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(this.workspacePath, { recursive: true }).catch(() => undefined)
    this.credentials = await this.credentialStore.load()
    this.router.setOwnerOpenId(this.credentials?.ownerOpenId)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    if (!this.credentials) return
    void this.connectSavedCredentials()
  }

  getSnapshot(): FeishuConnectionSnapshot {
    // The live websocket is the source of truth for "connected": the SDK can
    // drop/re-establish the socket underneath the connect-state machine (and
    // the state machine intentionally keeps working through a reconnect), so
    // the badge must never say 未连接 while the channel is actually up.
    const wsConnected = this.channel?.websocketState === 'connected'
    const connected = this.state === 'connected' || wsConnected
    const status: ConnectionStatus =
      connected && this.state !== 'degraded' ? 'connected' :
      this.state === 'degraded' ? 'degraded' :
      this.state === 'waiting_for_scan' ? 'waiting_for_user' :
      this.state === 'starting_registration' || this.state === 'registration_confirmed' || this.state === 'storing_credentials' || this.state === 'configuring_app' || this.state === 'starting_channel' || this.state === 'probing' ? 'connecting' :
      this.state === 'needs_admin_approval' ? 'needs_attention' :
      this.state === 'failed' || this.state === 'unsupported_registration' ? 'failed' : 'disconnected'
    return {
      definition: FEISHU_DEFINITION,
      status,
      state: this.state,
      connected,
      appIdMasked: this.credentials?.appId ? maskSecret(this.credentials.appId) : undefined,
      tenantBrand: this.credentials?.tenantBrand ?? this.credentials?.brand,
      botName: this.channel?.botName,
      botOpenId: this.channel?.botOpenId,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastReconnectAt: this.lastReconnectAt,
      websocketState: this.channel?.websocketState,
      authorizedCapabilities: [...this.authorizedCapabilities]
    }
  }

  async beginConnection(brand: LarkBrand = 'feishu'): Promise<FeishuConnectionResult> {
    if (this.state === 'connected') return { ok: true, snapshot: this.getSnapshot() }
    if (getStore('feishuExperimentalPersonalAgentRegistration') !== true) {
      this.state = 'unsupported_registration'
      this.lastError = '当前飞书账号暂不支持一键创建。'
      this.emitState()
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
    }
    this.state = 'starting_registration'
    this.lastError = undefined
    this.emitState()
    try {
      this.registration = await this.registrationProvider.begin(brand)
      this.registrationAbort?.abort()
      this.registrationAbort = new AbortController()
      this.state = 'waiting_for_scan'
      this.emitState()
      const view: FeishuRegistrationView = {
        verificationUri: this.registration.verificationUri,
        verificationUriComplete: this.registration.verificationUriComplete,
        userCode: this.registration.userCode,
        expiresAt: Date.now() + this.registration.expiresIn * 1000
      }
      void this.finishRegistration(this.registration, this.registrationAbort)
      return { ok: true, snapshot: this.getSnapshot(), registration: view }
    } catch (error) {
      return this.failRegistration(error)
    }
  }

  async connectManual(input: FeishuManualCredentials): Promise<FeishuConnectionResult> {
    const appId = input.appId.trim()
    const appSecret = input.appSecret.trim()
    if (!/^cli_[A-Za-z0-9_-]{4,200}$/.test(appId) || appSecret.length < 8 || appSecret.length > 500) {
      return { ok: false, error: '请检查 App ID 和 App Secret。', snapshot: this.getSnapshot() }
    }
    await this.disconnectChannelOnly()
    this.state = 'storing_credentials'
    this.lastError = undefined
    this.emitState()
    const next: Omit<FeishuStoredCredentials, 'savedAt'> = { appId, appSecret, brand: input.brand, tenantBrand: input.brand }
    try {
      const stored = { ...next, savedAt: Date.now() }
      this.router.setOwnerOpenId(stored.ownerOpenId)
      await this.connectCredentials(stored)
      await this.credentialStore.save(next)
      this.credentials = stored
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      await this.disconnectChannelOnly()
      this.lastError = friendlyError(error)
      this.state = 'failed'
      this.emitState()
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
    }
  }

  async cancelConnection(): Promise<FeishuConnectionSnapshot> {
    this.registrationAbort?.abort()
    if (this.registration) void this.registrationProvider.cancel(this.registration)
    this.registration = null
    this.registrationAbort = null
    this.state = 'idle'
    this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  async disconnect(): Promise<FeishuConnectionSnapshot> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    await this.cancelConnection()
    await this.disconnectChannelOnly()
    await this.router.shutdown()
    await this.credentialStore.clear()
    this.credentials = null
    this.authorizedCapabilities = ['messaging']
    this.state = 'idle'
    this.emitState()
    return this.getSnapshot()
  }

  async openUrl(url: string): Promise<boolean> {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return false
      await shell.openExternal(parsed.toString())
      return true
    } catch {
      return false
    }
  }

  async executeTool(_sessionId: string, request: FeishuToolRequest): Promise<FeishuToolResult> {
    await this.oauthManager.ensureFreshToken().catch(() => false)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    const result = await this.tools.execute(request)
    return result
  }

  async beginOAuth(capability: FeishuCapability): Promise<FeishuOAuthBeginResult> {
    try {
      const authorization = await this.oauthManager.begin(capability)
      const view: FeishuOAuthAuthorizationView = { ...authorization, capability }
      return { ok: true, authorization: view, snapshot: this.getSnapshot() }
    } catch (error) {
      const message = friendlyError(error)
      this.lastError = message
      this.emitState()
      return { ok: false, error: message, snapshot: this.getSnapshot() }
    }
  }

  async pollOAuth(): Promise<FeishuConnectionSnapshot> {
    const success = await this.oauthManager.poll().catch(() => false)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    if (!success) this.lastError = '额外授权没有完成，请重新打开授权链接。'
    else this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  async cancelOAuth(): Promise<FeishuConnectionSnapshot> {
    this.oauthManager.cancel()
    return this.getSnapshot()
  }

  private async finishRegistration(session: RegistrationSession, controller: AbortController): Promise<void> {
    try {
      const result = await this.registrationProvider.poll(session, controller.signal)
      if (controller.signal.aborted) return
      this.state = 'registration_confirmed'
      this.emitState()
      this.state = 'storing_credentials'
      this.emitState()
      const brand = result.tenantBrand ?? 'feishu'
      const credentials: Omit<FeishuStoredCredentials, 'savedAt'> = {
        appId: result.clientId,
        appSecret: result.clientSecret,
        ownerOpenId: result.ownerOpenId,
        tenantBrand: brand,
        brand
      }
      const stored = { ...credentials, savedAt: Date.now() }
      this.router.setOwnerOpenId(stored.ownerOpenId)
      await this.connectCredentials(stored)
      await this.credentialStore.save(credentials)
      this.credentials = stored
      this.registration = null
      this.registrationAbort = null
    } catch (error) {
      if (controller.signal.aborted) return
      this.registration = null
      this.registrationAbort = null
      this.lastError = friendlyError(error)
      this.state = this.lastError.includes('暂不支持') ? 'unsupported_registration' : 'failed'
      this.emitState()
    }
  }

  private async connectSavedCredentials(): Promise<void> {
    if (!this.credentials) return
    try {
      await this.connectCredentials(this.credentials)
    } catch (error) {
      this.lastError = friendlyError(error)
      this.state = 'failed'
      this.emitState()
      this.scheduleReconnect()
    }
  }

  private async connectCredentials(credentials: FeishuStoredCredentials): Promise<void> {
    await this.disconnectChannelOnly()
    this.state = 'starting_channel'
    this.emitState()
    const channel = new FeishuChannel(credentials, {
      onMessage: (message) => {
        this.lastMessageAt = Date.now()
        this.emitState()
        return this.router.handleInbound(message)
      },
      onReconnecting: () => {
        this.lastReconnectAt = Date.now()
        // The SDK reconnects on its own; a transient socket drop must not
        // demote a connected session back into the "configuring" states (the
        // UI would show 正在配置飞书 forever during a reconnect storm).
        // websocketState in the snapshot still shows 'reconnecting' live.
        if (this.state !== 'connected') {
          this.state = 'starting_channel'
        }
        this.emitState()
      },
      onReconnected: () => {
        this.lastConnectedAt = Date.now()
        this.state = 'connected'
        this.emitState()
      },
      onError: (error) => {
        this.lastError = friendlyError(error)
        this.state = 'degraded'
        this.emitState()
      }
    })
    this.channel = channel
    this.state = 'probing'
    this.emitState()
    try {
      await channel.connect()
    } catch (error) {
      await channel.disconnect().catch(() => undefined)
      if (this.channel === channel) this.channel = null
      throw error
    }
    this.lastConnectedAt = Date.now()
    this.lastError = undefined
    this.state = 'connected'
    this.emitState()
    console.info('[feishu] websocket connected')
  }

  private async disconnectChannelOnly(): Promise<void> {
    const current = this.channel
    this.channel = null
    if (current) await current.disconnect().catch(() => undefined)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.credentials) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectSavedCredentials()
    }, 15_000)
  }

  private async sendProgress(chatId: string, sourceMessageId: string | undefined, inThread: boolean): Promise<void> {
    if (!this.channel || !sourceMessageId || this.progressMessageKeys.has(sourceMessageId)) return
    this.progressMessageKeys.add(sourceMessageId)
    try {
      await this.channel.sendMarkdown(chatId, '⏳ 正在分析…', { replyTo: sourceMessageId, replyInThread: inThread })
    } catch {
      // The final answer will still be attempted.
    }
  }

  private async sendReply(chatId: string, content: string, sourceMessageId: string, inThread: boolean): Promise<void> {
    if (!this.channel) return
    try {
      await this.channel.sendMarkdown(chatId, content, { replyTo: sourceMessageId || undefined, replyInThread: inThread })
    } catch (error) {
      this.lastError = friendlyError(error)
      this.state = 'degraded'
      this.emitState()
    } finally {
      if (sourceMessageId) this.progressMessageKeys.delete(sourceMessageId)
    }
  }

  private handleOmpEvent(event: SessionEvent): void {
    this.sessionEventSink?.(event)
    this.router.onSessionEvent(event)
  }

  private emitState(): void {
    const snapshot = this.getSnapshot()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.FEISHU_STATUS, snapshot)
    }
  }

  private failRegistration(error: unknown): FeishuConnectionResult {
    this.registration = null
    this.registrationAbort = null
    this.lastError = friendlyError(error)
    this.state = this.lastError.includes('不完整') ? 'unsupported_registration' : 'failed'
    this.emitState()
    return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
  }
}

function friendlyError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  if (/timeout|network|fetch|ECONN|ENOTFOUND/i.test(value)) return '暂时无法连接飞书服务，请检查网络后重试。'
  if (/secure credential storage/i.test(value)) return '系统安全存储暂不可用，请完成系统钥匙串解锁后重试。'
  return value.replace(/[\r\n]+/g, ' ').slice(0, 240) || '飞书连接失败，请重试。'
}

export const feishuConnectionManager = new FeishuConnectionManager()
