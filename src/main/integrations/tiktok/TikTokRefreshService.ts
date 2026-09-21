import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  TikTokCredentialInfo,
  TikTokRefreshOutcome,
  TikTokReportStatus
} from '../../../shared/tiktokReport'
import { getStore, setStore } from '../../store'
import {
  listTikTokCredentials,
  loadTikTokCredentials,
  mergeTikTokTokens,
  TikTokReportCredentials
} from './TikTokConnectionStore'
import { resolveTikTokToken, type ResolvedTikTokToken } from './resolveTikTokToken'
import { fetchIntegratedReport, refreshAccessToken, sortRowsByDateDesc, TikTokApiFetch } from './tiktokClient'
import { writeReportToDataset } from './tiktokReportDataset'

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
const MAX_ADVERTISERS_PER_REFRESH = 20

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
  private readonly resolveTokenImpl: () => Promise<ResolvedTikTokToken>
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing = false
  private lastRefreshAt: number | undefined
  private lastError: string | undefined
  private lastRowCount: number | undefined

  constructor(options: TikTokRefreshServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
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
  async refreshNow(): Promise<TikTokRefreshOutcome> {
    if (this.refreshing) {
      return { ok: false, error: 'refresh-in-progress', status: this.getStatus() }
    }
    this.refreshing = true
    this.emit()
    try {
      let resolved: ResolvedTikTokToken
      try {
        resolved = await this.resolveTokenImpl()
      } catch {
        resolved = { token: null, source: 'none' }
      }
      if (!resolved.token) {
        const error = 'not-configured'
        this.lastError = error
        this.emit()
        return { ok: false, error, status: this.getStatus() }
      }
      const token = await this.accessTokenForReport(resolved)
      const rows = await this.fetchRows(token, resolved.advertiserIds)
      const written = writeReportToDataset(rows, this.datasetsFile)
      if (!written.ok) throw new Error(`dataset-${written.error}`)
      this.lastRefreshAt = this.now()
      this.lastError = undefined
      this.lastRowCount = written.dataset.rows.length
      this.emit()
      return {
        ok: true,
        rowCount: written.dataset.rows.length,
        truncated: written.truncated,
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

  /** One query per granted advertiser (or one token-scoped query), merged. */
  private async fetchRows(accessToken: string, grantedAdvertiserIds: number[]) {
    const nowDate = new Date(this.now())
    const end = formatLocalDate(nowDate)
    const startDate = new Date(nowDate)
    startDate.setDate(startDate.getDate() - (REPORT_RANGE_DAYS - 1))
    const start = formatLocalDate(startDate)
    const advertiserIds = grantedAdvertiserIds.slice(0, MAX_ADVERTISERS_PER_REFRESH)
    const queries = advertiserIds.length > 0 ? advertiserIds : [undefined]
    const rows = []
    for (const advertiserId of queries) {
      rows.push(
        ...(await fetchIntegratedReport(this.fetchImpl, {
          accessToken,
          startDate: start,
          endDate: end,
          ...(advertiserId !== undefined ? { advertiserId } : {})
        }))
      )
    }
    return sortRowsByDateDesc(rows)
  }

  /** Test-only: drop timers and module state so cases start clean. */
  resetForTest(): void {
    this.stop()
    this.refreshing = false
    this.lastRefreshAt = undefined
    this.lastError = undefined
    this.lastRowCount = undefined
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}

/** App-wide instance wired to the real stores; handlers live in ipc.ts. */
export const tiktokReportService = new TikTokRefreshService()
