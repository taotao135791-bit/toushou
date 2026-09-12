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
  FeishuOAuthBeginResult,
  FEISHU_CAPABILITY_SCOPES
} from '../../../shared/connections'
import { Session, SessionEvent, ExternalSessionDescriptor } from '../../../shared/types'
import { createSession, getSession, getSessionState, killSession, resumeSession, sendMessage } from '../../omp'
import { getStore } from '../../store'
import { FeishuChannel } from './FeishuChannel'
import { FeishuCredentialStore, FeishuStoredCredentials, maskSecret } from './FeishuCredentialStore'
import { PersonalAgentRegistrationProvider, RegistrationSession } from './FeishuAppRegistration'
import { FeishuOAuthManager } from './FeishuOAuthManager'
import { FeishuSessionContext, FeishuSessionRouter } from './FeishuSessionRouter'
import { FeishuToolRegistry } from './FeishuToolRegistry'

const FEISHU_DEFINITION: ConnectionDefinition = {
  id: 'feishu',
  kind: 'channel',
  label: '飞书',
  description: '把投手接入你的飞书工作空间。',
  capabilities: ['messaging', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write', 'bitable.read', 'bitable.write']
}

/** Every user-identity scope 投手 can consume — pre-filled on the one-click
 * registration/repair confirm page so the app is born (or patched) with the
 * full set; the OAuth consent page then never refuses a requested scope. */
const ALL_USER_SCOPES = Object.values(FEISHU_CAPABILITY_SCOPES).map((meta) => meta.scope)

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
  private reconnectAttempts = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  /** Replies that could not be shipped while the socket was down (M3). */
  private readonly pendingReplies: { chatId: string; content: string; replyTo: string; inThread: boolean }[] = []
  private progressMessageKeys = new Set<string>()
  private sessionEventSink: ((event: SessionEvent) => void) | null = null
  private externalSessionSink: ((descriptor: ExternalSessionDescriptor) => void) | null = null
  private state: FeishuConnectState = 'idle'
  /** True while a scan-to-update session runs against the stored app (permission repair). */
  private repairMode = false
  private lastError: string | undefined
  private lastConnectedAt: number | undefined
  private lastMessageAt: number | undefined
  private lastReconnectAt: number | undefined
  private authorizedCapabilities: FeishuCapability[] = ['messaging']
  private initialized = false
  private sessionOriginRecorder: ((sessionFile: string, origin: 'feishu' | 'task') => void) | undefined

  constructor() {
    this.router = new FeishuSessionRouter({
      workspacePath: this.workspacePath,
      routesFile: this.routesFile,
      createSession: (cwd, _onEvent, opts, ctx) => {
        const session = createSession(cwd, (event) => {
          // The durable file is only knowable after the handshake; tap the
          // connected moment so the restart-surviving history row keeps its
          // badge (a one-shot fetch at spawn time races the handshake).
          if (event.type === 'connected') {
            const tryRecord = (delayMs: number) => {
              setTimeout(() => {
                void getSessionState(event.sessionId).then((state) => {
                  if (state?.sessionFile) this.sessionOriginRecorder?.(state.sessionFile, 'feishu')
                })
              }, delayMs)
            }
            tryRecord(0)
            tryRecord(5_000)
          }
          this.handleOmpEvent(event)
        }, {
          ...opts,
          origin: 'feishu'
        })
        if (session.status !== 'error') {
          this.emitExternalSession(session, ctx)
        }
        return session
      },
      sendMessage,
      getSession,
      getSessionState,
      resumeSession: async (cwd, _onEvent, filePath, ctx, opts) => {
        this.sessionOriginRecorder?.(filePath, 'feishu')
        const result = await resumeSession(cwd, (event) => this.handleOmpEvent(event), filePath, {
          permissionMode: opts?.permissionMode,
          origin: 'feishu'
        })
        if (result) {
          this.emitExternalSession(result.session, ctx)
        }
        return result ? { session: result.session, messages: result.messages } : null
      },
      killSession,
      onReply: (route, content, sourceMessageId) => this.sendReply(route.chatId, content, sourceMessageId, Boolean(route.rootId || route.threadId)),
      onProgress: (route) => this.sendProgress(route.chatId, route.activeSourceMessageId ?? route.lastMessageId, Boolean(route.rootId || route.threadId)),
      ownerOpenId: undefined,
      onOwnerDiscovered: (openId) => {
        // Trust-on-first-use owner (manual credentials): persist the claim so
        // it survives restarts; without it the whole p2p channel is deaf.
        const { savedAt: _savedAt, ...rest } = this.credentials ?? {
          appId: '',
          appSecret: '',
          brand: 'feishu' as const
        }
        if (!rest.appId) return
        this.credentials = { ...rest, ownerOpenId: openId, savedAt: Date.now() }
        void this.credentialStore.save(rest).catch(() => undefined)
        console.info('[feishu] owner learned from first direct message')
      }
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

  setExternalSessionSink(sink: (descriptor: ExternalSessionDescriptor) => void): void {
    this.externalSessionSink = sink
  }

  /**
   * Durable provenance hook: Main's session-origin index records which durable
   * transcript files belong to Feishu chats, so history rows keep their badge
   * after a restart (the live registry's Session.origin is memory-only).
   */
  setSessionOriginRecorder(recorder: (sessionFile: string, origin: 'feishu' | 'task') => void): void {
    this.sessionOriginRecorder = recorder
  }

  /**
   * Announce a channel-created session to the GUI so it can register a live
   * sidebar row. The descriptor is path-free and carries no route data: no
   * chat ids, no route keys, no session-file paths — those stay Main-owned.
   */
  private emitExternalSession(session: Session, ctx?: FeishuSessionContext): void {
    const chatType = ctx?.chatType ?? 'p2p'
    this.externalSessionSink?.({
      sessionId: session.id,
      workspacePath: this.workspacePath,
      origin: 'feishu',
      chatType,
      // Main has no i18n layer; plain zh matches the existing Main-side copy
      // convention (connection labels, error strings).
      suggestedTitle: chatType === 'group' ? '飞书群聊' : '飞书私聊',
      createdAt: session.createdAt || Date.now()
    })
  }

  /** Non-blocking startup recovery for stored credentials. */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(this.workspacePath, { recursive: true }).catch(() => undefined)
    const hadStoredCredentials = await this.credentialStore.exists()
    this.credentials = await this.credentialStore.load()
    if (hadStoredCredentials && !this.credentials) {
      // A stored envelope that cannot be read (keychain mismatch after a
      // system migration) must not look like "never connected".
      this.lastError = '已保存的飞书凭据无法读取，请重新扫码连接。'
      this.state = 'failed'
      this.emitState()
      return
    }
    this.router.setOwnerOpenId(this.credentials?.ownerOpenId)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    this.startWatchdog()
    // Badge continuity for already-routed chats: the route index knows which
    // durable files are Feishu conversations, so seed the origin index before
    // the next inbound message instead of waiting for a resume to record it.
    await this.router.load()
    for (const route of this.router.listRoutes()) {
      if (route.sessionFile) this.sessionOriginRecorder?.(route.sessionFile, 'feishu')
    }
    if (!this.credentials) return
    void this.connectSavedCredentials()
  }

  getSnapshot(): FeishuConnectionSnapshot {
    // The live websocket is the source of truth for "connected": the SDK can
    // drop/re-establish the socket underneath the connect-state machine (and
    // the state machine intentionally keeps working through a reconnect), so
    // the badge must never say 未连接 while the channel is actually up.
    // Truth order: the live socket wins. A sticky 'connected' state must not
    // mask a dead socket — but during an SDK-managed reconnect the socket
    // reports 'reconnecting' and the session genuinely stays usable.
    const ws = this.channel?.websocketState
    const connected = ws === 'connected' || (this.state === 'connected' && ws === 'reconnecting')
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
      /** Which flow the pending registration belongs to (repair = scan-to-update). */
      registrationMode: this.repairMode ? 'repair' : 'connect',
      appIdMasked: this.credentials?.appId ? maskSecret(this.credentials.appId) : undefined,
      // Deep link into THIS app's permission console page (appId is public —
      // it rides every authorize URL — so exposing the URL is safe; the
      // renderer never sees the secret).
      consoleAuthUrl: this.credentials?.appId
        ? `https://open.feishu.cn/app/${this.credentials.appId}/auth`
        : undefined,
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
    // "Retry" with stored credentials means RECONNECT — a fresh QR
    // registration would silently orphan the existing Feishu app.
    if (this.credentials) {
      try {
        await this.connectCredentials(this.credentials)
        return { ok: true, snapshot: this.getSnapshot() }
      } catch (error) {
        this.lastError = friendlyError(error)
        this.state = 'failed'
        this.emitState()
        this.scheduleReconnect()
        return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
      }
    }
    if (getStore('feishuExperimentalPersonalAgentRegistration') !== true) {
      this.state = 'unsupported_registration'
      this.lastError = '当前飞书账号暂不支持一键创建。'
      this.emitState()
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
    }
    this.state = 'starting_registration'
    this.repairMode = false
    this.lastError = undefined
    this.emitState()
    try {
      this.registration = await this.registrationProvider.begin(brand, { userScopes: ALL_USER_SCOPES })
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
    const wasRepair = this.repairMode
    this.repairMode = false
    // Cancelling a repair must not demote a live channel to “未连接”: the
    // stored app and websocket are untouched by an aborted scan.
    this.state = wasRepair && this.channel?.websocketState === 'connected' ? 'connected' : 'idle'
    this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  /**
   * Permission repair for an already-registered app: re-runs the one-click
   * device flow in update mode (clientID = stored app) with every user scope
   * pre-filled, so the confirm page patches the app in place — no developer
   * console, no version publish. On confirmation the manager automatically
   * opens the OAuth consent page for the full grant.
   */
  async beginPermissionRepair(): Promise<FeishuConnectionResult> {
    const credentials = await this.credentialStore.load()
    if (!credentials) {
      this.lastError = '飞书尚未连接。'
      this.emitState()
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
    }
    if (getStore('feishuExperimentalPersonalAgentRegistration') !== true) {
      this.state = 'unsupported_registration'
      this.lastError = '当前飞书账号暂不支持一键创建。'
      this.emitState()
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() }
    }
    this.state = 'starting_registration'
    this.repairMode = true
    this.lastError = undefined
    this.emitState()
    try {
      this.registration = await this.registrationProvider.begin(credentials.brand, {
        appId: credentials.appId,
        userScopes: ALL_USER_SCOPES
      })
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

  async executeTool(sessionId: string, request: FeishuToolRequest): Promise<FeishuToolResult> {
    await this.oauthManager.ensureFreshToken().catch(() => false)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    // executeForSession wraps execute() with the per-session failure breaker.
    const result = await this.tools.executeForSession(sessionId, request)
    return result
  }

  async beginOAuth(capability: FeishuCapability | 'all'): Promise<FeishuOAuthBeginResult> {
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

  /** 刷新令牌并按已授权 scope 重建能力清单（权限核验按钮）。 */
  async verifyScopes(): Promise<FeishuConnectionSnapshot> {
    await this.oauthManager.ensureFreshToken().catch(() => false)
    this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
    this.emitState()
    return this.getSnapshot()
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
      if (this.repairMode) {
        this.repairMode = false
        void this.chainPermissionOAuth()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      const wasRepair = this.repairMode
      this.repairMode = false
      this.registration = null
      this.registrationAbort = null
      this.lastError = friendlyError(error)
      // A failed repair leaves the live channel untouched — keep it “已连接”
      // instead of falling into the disconnected failure view.
      this.state =
        wasRepair && this.channel?.websocketState === 'connected'
          ? 'connected'
          : this.lastError.includes('暂不支持')
            ? 'unsupported_registration'
            : 'failed'
      this.emitState()
    }
  }

  /** After a repair confirmation: automatically open the OAuth consent page
   * for the full grant and settle the capability checklist. Runs unattended
   * in Main; the renderer follows along through status broadcasts. */
  private async chainPermissionOAuth(): Promise<void> {
    try {
      const authorization = await this.oauthManager.begin('all')
      await this.openUrl(authorization.verificationUriComplete)
      const granted = await this.oauthManager.poll().catch(() => false)
      this.authorizedCapabilities = await this.oauthManager.authorizedCapabilities()
      if (!granted) this.lastError = '额外授权没有完成，请重新打开授权链接。'
    } catch {
      this.lastError = '补齐权限未完成，请重试一键授权。'
    }
    this.emitState()
  }

  private async connectSavedCredentials(): Promise<void> {
    if (!this.credentials) return
    try {
      await this.connectCredentials(this.credentials)
      this.reconnectAttempts = 0
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
        this.reconnectAttempts = 0
        this.state = 'connected'
        this.lastError = undefined
        this.emitState()
        void this.flushPendingReplies()
      },
      onError: (error) => {
        this.lastError = friendlyError(error)
        this.state = 'degraded'
        this.emitState()
        // Degraded used to be terminal — schedule recovery instead of
        // leaving the bot silent until a manual disconnect.
        this.scheduleReconnect()
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

  /** Reconnect with capped backoff: 15s → 30s → 60s → 120s → 5min cap. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.credentials) return
    const delays = [15_000, 30_000, 60_000, 120_000, 300_000]
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)]
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectSavedCredentials()
    }, delay)
  }

  /**
   * Safety net for socket states the SDK gives up on ('failed') or a
   * degraded state with no error callback: once a minute, force a recovery
   * attempt when things look dead.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      if (!this.credentials || this.reconnectTimer) return
      const ws = this.channel?.websocketState
      const dead =
        ws === 'failed' || ws === 'idle' || (this.state === 'degraded' && ws !== 'connected')
      if (dead) this.scheduleReconnect()
    }, 60_000)
  }

  /** Ship replies that queued up while the socket was down (M3). */
  private async flushPendingReplies(): Promise<void> {
    while (this.pendingReplies.length > 0) {
      const next = this.pendingReplies[0]
      try {
        await this.channel?.sendMarkdown(next.chatId, next.content, {
          replyTo: next.replyTo || undefined,
          replyInThread: next.inThread
        })
      } catch {
        // Still down — keep the queue for the next reconnect.
        return
      }
      this.pendingReplies.shift()
    }
  }

  private async sendProgress(chatId: string, sourceMessageId: string | undefined, inThread: boolean): Promise<void> {
    if (!this.channel || !sourceMessageId || this.progressMessageKeys.has(sourceMessageId)) return
    // Misaligned/abandoned turns used to leak their keys forever.
    if (this.progressMessageKeys.size >= 500) {
      const oldest = this.progressMessageKeys.values().next().value
      if (oldest) this.progressMessageKeys.delete(oldest)
    }
    this.progressMessageKeys.add(sourceMessageId)
    try {
      await this.channel.sendMarkdown(chatId, '⏳ 正在分析…', { replyTo: sourceMessageId, replyInThread: inThread })
    } catch {
      // The final answer will still be attempted.
    }
  }

  private async sendReply(chatId: string, content: string, sourceMessageId: string, inThread: boolean): Promise<void> {
    try {
      if (!this.channel) throw new Error('channel is down')
      // 30k is the API ceiling — tell the user instead of a silent tail-cut.
      const body = content.length > 30_000 ? `${content.slice(0, 30_000)}\n\n（内容过长，已截断）` : content
      await this.channel.sendMarkdown(chatId, body, { replyTo: sourceMessageId || undefined, replyInThread: inThread })
    } catch (error) {
      // Queue instead of dropping: the answer must survive a socket blip.
      if (this.pendingReplies.length < 50) {
        this.pendingReplies.push({ chatId, content, replyTo: sourceMessageId, inThread })
      }
      this.lastError = friendlyError(error)
      this.state = 'degraded'
      this.emitState()
      this.scheduleReconnect()
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
