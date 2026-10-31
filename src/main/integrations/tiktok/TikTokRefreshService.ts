import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  TikTokCredentialInfo,
  TikTokRefreshOutcome,
  TikTokReportStatus,
  tiktokAccountDate
} from '../../../shared/tiktokReport'
import { getStore, setStore } from '../../store'
import {
  listTikTokCredentials,
  loadTikTokCredentials,
  mergeTikTokTokens,
  TikTokReportCredentials
} from './TikTokConnectionStore'
import { resolveTikTokToken, type ResolvedTikTokToken } from './resolveTikTokToken'
import { classifyTikTokError, fetchIntegratedReport, refreshAccessToken, sortRowsByDateDesc, TikTokApiFetch, TikTokReportRow } from './tiktokClient'
import { TikTokMcpReadingClient, TIKTOK_DISCOVERED_ACCOUNT_LIMIT, TIKTOK_METADATA_BATCH_SIZE } from './tiktokMcpReadingClient'
import { proxySessionFetch } from './proxyFetch'
import { TikTokCredentialStorageError } from './tiktokCredentialStorageError'
import { beginTikTokDatasetRead, mergeReportRowsIntoDataset, type TikTokDatasetScope, type TikTokAdvertiserDetail } from './tiktokReportDataset'
import { DATASET_LIMITS } from '../../../shared/datasets'

/**
 * TikTok 报表自动刷新服务 — 一个轻量的 setInterval 驱动服务（默认每 30 分钟
 * 一次），与 prompt 式 scheduledTasks 完全无关：开关持久化在 electron-store
 * 的 tiktokAutoRefresh 里，stop/start 随时可取消。每次刷新拉最近 7 天的
 * 集成报表并整体覆写 "TikTok 报表" 数据集；最近成功时间与最近错误都留在
 * 内存状态并推送给渲染层。
 */

export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000
export const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000
/** Report window: last 7 days including today (today's row is partial). */
export const REPORT_RANGE_DAYS = 7
/** Refresh the access token when less than this remains (24h-lived tokens). */
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000
/** Cap per-credential advertiser fan-out — protects against a huge id list. */
const MAX_ADVERTISERS_PER_REFRESH = TIKTOK_DISCOVERED_ACCOUNT_LIMIT

function incompleteRefresh(completed: number, total: number, error: unknown): Error {
  const reason = error instanceof Error && error.message === 'account-timezone-unavailable' ? '账户时区不可用' : error instanceof Error && error.message === 'report-row-limit' ? '报表行数超过安全上限，请缩短日期或缩小账户范围' : classifyTikTokError(error).code
  return new Error(`账户读取未完成：已完成 ${completed}，失败 1，未尝试 ${Math.max(0, total - completed - 1)}（${reason}）；未更新数据，请检查后重试。`)
}

export interface TikTokRefreshSettings {
  getAutoRefresh(): boolean
  setAutoRefresh(value: boolean): void
}

/** Default persistence: the app's electron-store (omp-gui-settings.json). */
export const electronStoreSettings: TikTokRefreshSettings = {
  getAutoRefresh: () => getStore('tiktokAutoRefresh'),
  setAutoRefresh: (value) => setStore('tiktokAutoRefresh', value)
}

export interface TikTokRefreshServiceOptions {
  fetchImpl?: TikTokApiFetch
  now?: () => number
  intervalMs?: number
  settings?: TikTokRefreshSettings
  credentialsFile?: string
  datasetsFile?: string
  /**
   * Token source override (tests inject fakes). Defaults to the shared
   * resolver: OAuth connector first, this service's paste store as fallback.
   */
  resolveToken?: () => Promise<ResolvedTikTokToken>
  /** Test seam: where status pushes go (defaults to every app window). */
  broadcast?: (status: TikTokReportStatus) => void
  /** Called only after the dataset commit succeeds; carries no account data. */
  onDatasetCommitted?: () => void
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class TikTokRefreshService {
  private readonly fetchImpl: TikTokApiFetch
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly settings: TikTokRefreshSettings
  private readonly credentialsFile: string | undefined
  private readonly datasetsFile: string | undefined
  private readonly broadcastImpl: (status: TikTokReportStatus) => void
  private readonly onDatasetCommitted: () => void
  private readonly resolveTokenImpl: () => Promise<ResolvedTikTokToken>
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing = false
  private lastRefreshAt: number | undefined
  private lastError: string | undefined
  private lastRowCount: number | undefined
  private legacyBackups: string[] = []

  constructor(options: TikTokRefreshServiceOptions = {}) {
    // Default fetch is proxy-aware (env vars → OS proxy, never forced direct):
    // business-api.tiktok.com is unreachable without a proxy on many networks.
    this.fetchImpl =
      options.fetchImpl ??
      (async (url: string, init?: RequestInit) => (await proxySessionFetch())(url, init))
    this.now = options.now ?? Date.now
    this.intervalMs = Math.max(
      MIN_REFRESH_INTERVAL_MS,
      options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    )
    this.settings = options.settings ?? electronStoreSettings
    this.credentialsFile = options.credentialsFile
    this.datasetsFile = options.datasetsFile
    this.broadcastImpl =
      options.broadcast ??
      ((status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.TIKTOK_REPORT_STATUS, status)
        }
      })
    this.onDatasetCommitted = options.onDatasetCommitted ?? (() => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.TT_READING_DATASET_CHANGED) } catch { /* a closing window must not prevent other notifications */ }
      }
    })
    // Default token source: the shared resolver with THIS service's paste
    // store (an injected credentialsFile must keep working in tests).
    this.resolveTokenImpl =
      options.resolveToken ??
      (() => resolveTikTokToken({ loadPastedCredentials: () => loadTikTokCredentials(this.credentialsFile) }))
  }

  // ------------------------------------------------------------------ state

  getStatus(): TikTokReportStatus {
    const info: TikTokCredentialInfo = listTikTokCredentials(this.credentialsFile)
    return {
      configured: info.configured,
      autoRefresh: this.settings.getAutoRefresh(),
      refreshing: this.refreshing,
      ...(this.lastRefreshAt !== undefined ? { lastRefreshAt: this.lastRefreshAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.lastRowCount !== undefined ? { lastRowCount: this.lastRowCount } : {}),
      ...(this.legacyBackups.length ? { legacyBackups: this.legacyBackups } : {}),
      info
    }
  }

  private emit(): void {
    this.broadcastImpl(this.getStatus())
  }

  // -------------------------------------------------------------- auto timer

  /** Whether the interval timer is running (auto-refresh active). */
  isRunning(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // The tick must never take the main process down (same posture as the
      // scheduled-task engine's interval).
      void this.refreshNow().catch((error) => {
        console.error('[tiktok-report] auto-refresh tick crashed:', error)
      })
    }, this.intervalMs)
  }

  /** Cancel the auto-refresh timer. A running refresh finishes on its own. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** App-start hook: restart auto-refresh when the persisted toggle is on. */
  restoreFromSettings(): void {
    if (this.settings.getAutoRefresh()) this.start()
  }

  /** Persist the toggle and apply it (start/stop) — cancellable by design. */
  setAutoRefresh(enabled: boolean): TikTokReportStatus {
    this.settings.setAutoRefresh(Boolean(enabled))
    if (enabled) this.start()
    else this.stop()
    this.emit()
    return this.getStatus()
  }

  // ----------------------------------------------------------------- refresh

  /**
   * Pull the last-7-days integrated report and overwrite "TikTok 报表".
   * Manual calls and timer ticks share one no-overlap guard. The guard is
   * latched synchronously BEFORE the token resolver runs — resolving is
   * async, and a check-then-await gap would let two concurrent calls both
   * through. The token comes from the shared resolver (OAuth connector
   * first — it refreshes itself — paste store as fallback, keeping the
   * rotate-before-read branch alive).
   */
  async refreshNow(options: { advertiserId?: string; beforeWrite?: () => boolean } = {}): Promise<TikTokRefreshOutcome> {
    if (this.refreshing) {
      return { ok: false, error: 'refresh-in-progress', status: this.getStatus() }
    }
    if (options.advertiserId !== undefined && (typeof options.advertiserId !== 'string' || !/^[1-9]\d{0,24}$/.test(options.advertiserId))) {
      return { ok: false, error: 'invalid-advertiser', status: this.getStatus() }
    }
    this.refreshing = true
    const requestVersion = beginTikTokDatasetRead()
    this.emit()
    try {
      let resolved: ResolvedTikTokToken
      try {
        resolved = await this.resolveTokenImpl()
      } catch (error) {
        if (error instanceof TikTokCredentialStorageError || (error instanceof Error && error.message === 'tiktok-advertiser-selection-unavailable')) throw error
        resolved = { token: null, source: 'none' }
      }
      if (!resolved.token) {
        const error = 'not-configured'
        this.lastError = error
        this.emit()
        return { ok: false, error, status: this.getStatus() }
      }
      // OAuth (the official MCP connection) pulls through the MCP report
      // tool — same grant the reading cards use, no Open API credentials
      // needed — and discovers the granted advertisers when the token
      // response omitted them (the paste-store path keeps Open API below).
      let rows: TikTokReportRow[]
      let details: Map<string, TikTokAdvertiserDetail> | undefined
      let scopes: TikTokDatasetScope[]
      if (resolved.source === 'oauth') {
        const viaMcp = await this.fetchRowsViaMcp(resolved.token, resolved.advertiserIds, options.advertiserId, resolved.selectionExplicit)
        rows = viaMcp.rows
        details = viaMcp.details
        scopes = viaMcp.scopes
      } else {
        if (options.advertiserId && !resolved.advertiserIds.includes(options.advertiserId)) throw new Error('advertiser-not-authorized')
        const direct = await this.fetchRows(await this.accessTokenForReport(resolved), options.advertiserId ? [options.advertiserId] : resolved.advertiserIds)
        rows = direct.rows
        scopes = direct.scopes
      }
      if (options.beforeWrite) {
        let allowed = false
        try { allowed = options.beforeWrite() === true } catch { /* deny */ }
        if (!allowed) throw new Error('permission-denied')
      }
      const written = mergeReportRowsIntoDataset(rows, details, this.datasetsFile, scopes, requestVersion)
      if (!written.ok) throw new Error(`dataset-${written.error}`)
      try { this.onDatasetCommitted() } catch { /* notification is advisory */ }
      this.lastRefreshAt = this.now()
      this.lastError = undefined
      this.lastRowCount = written.dataset.rows.length
      this.legacyBackups = written.legacyBackups ?? []
      this.emit()
      return {
        ok: true,
        rowCount: written.dataset.rows.length,
        truncated: written.truncated,
        ...(this.legacyBackups.length ? { legacyBackups: this.legacyBackups } : {}),
        status: this.getStatus()
      }
    } catch (error) {
      this.lastError = friendlyError(error)
      this.emit()
      return { ok: false, error: this.lastError, status: this.getStatus() }
    } finally {
      this.refreshing = false
      this.emit()
    }
  }

  /**
   * The access token for this pull. OAuth-sourced tokens are managed (and
   * refreshed) by the connector itself — used as-is; a pasted token still
   * goes through the rotate logic below when it nears expiry.
   */
  private async accessTokenForReport(resolved: ResolvedTikTokToken): Promise<string> {
    if (resolved.source === 'oauth' && resolved.token) return resolved.token
    const credentials = loadTikTokCredentials(this.credentialsFile)
    if (!credentials) throw new Error('not-configured')
    return this.ensureFreshAccessToken(credentials)
  }

  /**
   * Use the stored access token; when it is inside the refresh margin (or
   * already expired) and long-lived OAuth material exists, rotate it via
   * /oauth2/refresh_token/ and persist the new one first.
   */
  private async ensureFreshAccessToken(credentials: TikTokReportCredentials): Promise<string> {
    const expiresAt = credentials.expiresAt
    const remaining = expiresAt !== undefined ? expiresAt - this.now() : Number.POSITIVE_INFINITY
    if (remaining > TOKEN_REFRESH_MARGIN_MS) return credentials.accessToken
    if (!credentials.refreshToken || !credentials.appId || !credentials.appSecret) {
      if (remaining <= 0) {
        throw new Error('token-expired')
      }
      // Pasted quick-access token still inside its lifetime: use it as-is.
      return credentials.accessToken
    }
    const tokens = await refreshAccessToken(this.fetchImpl, {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      refreshToken: credentials.refreshToken
    })
    const stored = mergeTikTokTokens(
      {
        accessToken: tokens.accessToken,
        ...(tokens.expiresIn !== undefined ? { expiresAt: this.now() + tokens.expiresIn * 1000 } : {}),
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {})
      },
      this.credentialsFile
    )
    return stored.accessToken
  }

  /** One query per advertiser, merged. The report API has no token-wide query. */
  private async fetchRows(accessToken: string, advertiserIds: string[]) {
    if (advertiserIds.length === 0) throw new Error('no-advertiser')
    if (advertiserIds.length > MAX_ADVERTISERS_PER_REFRESH) throw new Error('account-safety-limit-exceeded')
    const nowDate = new Date(this.now())
    const end = formatLocalDate(nowDate)
    const startDate = new Date(nowDate)
    startDate.setDate(startDate.getDate() - (REPORT_RANGE_DAYS - 1))
    const start = formatLocalDate(startDate)
    const scopes: TikTokDatasetScope[] = []
    const rows: TikTokReportRow[] = []
    for (const advertiserId of advertiserIds) {
      try {
        rows.push(...(await fetchIntegratedReport(this.fetchImpl, { accessToken, advertiserId, startDate: start, endDate: end }, DATASET_LIMITS.maxRows - rows.length)))
        scopes.push({ advertiserId, startDate: start, endDate: end, source: 'open-api' })
      } catch (error) { throw incompleteRefresh(scopes.length, advertiserIds.length, error) }
    }
    return { rows: sortRowsByDateDesc(rows), scopes }
  }

  /** The MCP report uses each account's verified local calendar. */
  private async fetchRowsViaMcp(token: string, advertiserIds: string[], selectedId?: string, selectionExplicit?: boolean): Promise<{ rows: TikTokReportRow[]; details: Map<string, TikTokAdvertiserDetail>; scopes: TikTokDatasetScope[] }> {
    const client = new TikTokMcpReadingClient(token, this.fetchImpl)
    await client.initialize()
    let ids: string[]
    if (selectedId) {
      const granted = await client.advertisers()
      if (!granted.includes(selectedId)) throw new Error('advertiser-not-authorized')
      ids = [selectedId]
    } else {
      ids = selectionExplicit === false ? await client.advertisers() : advertiserIds.length > 0 ? advertiserIds : await client.advertisers()
    }
    if (ids.length === 0) throw new Error('no-advertiser')
    if (ids.length > MAX_ADVERTISERS_PER_REFRESH) throw new Error('account-safety-limit-exceeded')
    const details = new Map<string, TikTokAdvertiserDetail>()
    const rows: TikTokReportRow[] = []
    const scopes: TikTokDatasetScope[] = []
    const now = this.now()
    for (let i = 0; i < ids.length; i += TIKTOK_METADATA_BATCH_SIZE) {
      const batch = ids.slice(i, i + TIKTOK_METADATA_BATCH_SIZE)
      try {
        for (const info of await client.info(batch)) details.set(info.advertiserId, { name: info.name, currency: info.currency, timezone: info.timezone })
      } catch (error) { throw incompleteRefresh(scopes.length, ids.length, error) }
      for (const advertiserId of batch) {
        try {
          const end = tiktokAccountDate(now, details.get(advertiserId)?.timezone)
          if (!end) throw new Error('account-timezone-unavailable')
          const start = new Date(Date.parse(`${end}T00:00:00Z`) - (REPORT_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
          rows.push(...(await client.report(advertiserId, start, end, DATASET_LIMITS.maxRows - rows.length)))
          scopes.push({ advertiserId, startDate: start, endDate: end, source: 'mcp' })
        } catch (error) { throw incompleteRefresh(scopes.length, ids.length, error) }
      }
    }
    return { rows: sortRowsByDateDesc(rows), details, scopes }
  }

  /** Test-only: drop timers and module state so cases start clean. */
  resetForTest(): void {
    this.stop()
    this.refreshing = false
    this.lastRefreshAt = undefined
    this.lastError = undefined
    this.lastRowCount = undefined
    this.legacyBackups = []
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'account-safety-limit-exceeded') return '授权账户超过 500 个安全上限，请在连接页缩小账户范围后重试。'
  if (message === 'tiktok-advertiser-selection-unavailable') return '无法读取已选账户，请检查连接页的账户选择后重试；未扩大读取范围。'
  return message.slice(0, 300)
}

/** App-wide instance wired to the real stores; handlers live in ipc.ts. */
export const tiktokReportService = new TikTokRefreshService()
