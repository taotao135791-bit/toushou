/**
 * TikTok Ads 后台报表接入（Open API v1.3）— Main 与 Renderer 共享的公共契约。
 *
 * 与 connections.ts 的 TikTok MCP 连接不同：这里走的是报表 Open API，凭据
 * 由 Main 保存在 userData 的 0600 JSON 里。渲染层只能看到脱敏投影
 * （token 永远不出主进程），写入路径由 Main 完成并落到 "TikTok 报表"
 * 看板数据集。
 */

/** 连接模式：未配置 / OAuth 换取（长期）/ 开发者控制台直接粘贴 token。 */
export type TikTokCredentialMode = 'none' | 'oauth' | 'pasted-token'

/** 渲染层可见的凭据投影 — 全部脱敏，绝无 secret 明文。 */
export interface TikTokCredentialInfo {
  configured: boolean
  mode: TikTokCredentialMode
  /** 脱敏后的 App ID，如 "73…90"。 */
  appIdMasked?: string
  /** 脱敏后的 access token，如 "abc…xyz"（首尾各 3 位）。 */
  tokenMasked: string
  hasRefreshToken: boolean
  /** 已保存的广告主 ID（数字，非机密）。 */
  advertiserIds: number[]
  /** access token 到期时间（epoch ms；粘贴路径可能缺失）。 */
  expiresAt?: number
  /** 粘贴路径记录的 token 签发时间（epoch ms）。 */
  issuedAt?: number
  savedAt?: number
}

/**
 * 保存凭据输入：表单字符串原样提交，advertiserIds 允许数字或数字字符串，
 * Main 侧统一做长度/字符校验后落盘。
 */
export interface TikTokCredentialInput {
  appId?: string
  appSecret?: string
  accessToken: string
  refreshToken?: string
  advertiserIds?: Array<number | string>
}

export type TikTokCredentialsSetResult =
  | { ok: true; info: TikTokCredentialInfo }
  | { ok: false; error: string }

/** 报表刷新服务对外状态（invoke 与推送共用同一种载荷）。 */
export interface TikTokReportStatus {
  configured: boolean
  /** electron-store 持久化的自动刷新开关。 */
  autoRefresh: boolean
  /** 当前是否有一次刷新在跑（手动与定时共用同一把防重入锁）。 */
  refreshing: boolean
  lastRefreshAt?: number
  lastError?: string
  /** 最近一次成功写入 "TikTok 报表" 的行数。 */
  lastRowCount?: number
  info: TikTokCredentialInfo
}

export type TikTokRefreshOutcome =
  | { ok: true; status: TikTokReportStatus; rowCount: number; truncated: boolean }
  | { ok: false; error: string; status: TikTokReportStatus }

/** Main 侧校验失败时的稳定错误码（渲染层用 i18n 映射为可读文案）。 */
export type TikTokCredentialErrorCode =
  | 'invalid-input'
  | 'missing-token'
  | 'invalid-token'
  | 'invalid-app-id'
  | 'invalid-secret'
  | 'invalid-refresh-token'
  | 'invalid-advertisers'
