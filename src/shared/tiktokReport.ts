import type { TikTokDatasetProof } from './tiktokDatasetProof'
/**
 * TikTok Ads 后台报表接入（Open API v1.3）— Main 与 Renderer 共享的公共契约。
 *
 * 与 connections.ts 的 TikTok MCP 连接不同：这里走的是报表 Open API，凭据
 * 由 Main 保存在 userData 的 0600 JSON 里。渲染层只能看到脱敏投影
 * （token 永远不出主进程），写入路径由 Main 完成并落到 "TikTok 报表"
 * 看板数据集。
 */

import type { ReadingErrorCode, ReadingFailure } from './readingError'

/** 连接模式：未配置 / OAuth 换取（长期）/ 开发者控制台直接粘贴 token。 */
export type TikTokCredentialMode = 'none' | 'oauth' | 'pasted-token'

/**
 * TikTok advertiser ids are 19-digit decimals, past Number.MAX_SAFE_INTEGER:
 * parsing one into a JS number rounds its last digits into a different
 * account. They stay decimal strings from the token response to the URL.
 */
const ADVERTISER_ID_RE = /^[1-9]\d{0,24}$/

export const TIKTOK_ADVERTISER_ID_LIMIT = 500

/** Longest accepted comma-separated advertiser list ("7300…, 7311…"). */
export const TIKTOK_ADVERTISER_LIST_MAX_LENGTH = 14_000

export function normalizeTikTokAdvertiserId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return ADVERTISER_ID_RE.test(trimmed) ? trimmed : null
  }
  // A JSON number this large has already lost digits; only exact ones survive.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return null
}

/** Keeps valid ids, de-duplicated and order-stable; anything else is dropped. */
export function normalizeTikTokAdvertiserIds(values: unknown, limit: number = TIKTOK_ADVERTISER_ID_LIMIT): string[] {
  if (!Array.isArray(values)) return []
  const ids: string[] = []
  for (const value of values) {
    if (ids.length >= limit) break
    const id = normalizeTikTokAdvertiserId(value)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Form text → advertiser ids. Separators are commas (ASCII or CJK),
 * semicolons and whitespace. Returns null when the text is too long or holds
 * anything that is not an id; blank text is an empty list.
 */
export function parseTikTokAdvertiserIdList(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length > TIKTOK_ADVERTISER_LIST_MAX_LENGTH) return null
  const ids: string[] = []
  for (const piece of raw.split(/[,，;；\s]+/)) {
    if (!piece) continue
    const id = normalizeTikTokAdvertiserId(piece)
    if (!id) return null
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length > TIKTOK_ADVERTISER_ID_LIMIT ? null : ids
}

/** Advertisers the board reads: the user's own pick, and what the authorization carried. */
export interface TikTokReadingAdvertisers {
  selected: string[]
  granted: string[]
}

export type TikTokReadingAdvertisersSetResult =
  | { ok: true; selected: string[] }
  | { ok: false; error: 'invalid-input' | 'write-failed' }

/** 渲染层可见的凭据投影 — 全部脱敏，绝无 secret 明文。 */
export interface TikTokCredentialInfo {
  configured: boolean
  mode: TikTokCredentialMode
  /** 脱敏后的 App ID，如 "73…90"。 */
  appIdMasked?: string
  /** 脱敏后的 access token，如 "abc…xyz"（首尾各 3 位）。 */
  tokenMasked: string
  hasRefreshToken: boolean
  /** 已保存的广告主 ID（十进制字符串，非机密）。 */
  advertiserIds: string[]
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
  /** User-visible legacy datasets preserved by migration. */
  legacyBackups?: string[]
  /** 最近一次成功写入 "TikTok 报表" 的行数。 */
  lastRowCount?: number
  info: TikTokCredentialInfo
}

export type TikTokRefreshOutcome =
  | { ok: true; status: TikTokReportStatus; rowCount: number; truncated: boolean; legacyBackups?: string[] }
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

// ---------------------------------------------------------------------------
// TT 读数 board module. Main uses the application-managed OAuth MCP
// connection to read and aggregate reports; the renderer only receives
// this bounded projection.
// ---------------------------------------------------------------------------

/** 报表天数口径：今天（未收完）/ 近 7 天 / 近 28 天（都截止到昨天，整天）。 */
export type TikTokReadingRange = '1' | 'yd' | '3' | '7' | '28' | '30'

/** Calendar day for a verified account timezone, independent of host timezone. */
export function tiktokAccountDate(now: number, timezone: string | null | undefined): string | null {
  if (!timezone || !Number.isFinite(now)) return null
  const zone = timezone.trim()
  const offset = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(zone)
  if (offset) {
    const hours = Number(offset[2]), minutes = Number(offset[3] ?? 0)
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
    const shift = (hours * 60 + minutes) * 60_000 * (offset[1] === '+' ? 1 : -1)
    const date = new Date(now + shift)
    return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : null
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
    const year = value('year'), month = value('month'), day = value('day')
    return year && month && day ? `${year}-${month}-${day}` : null
  } catch { return null }
}

export interface TikTokReadingAdvertiser {
  advertiserId: string
  /** From the advertiser info call; null when TikTok did not return it. */
  name: string | null
  currency: string | null
  /** Verified account timezone; unknown is never guessed. */
  timezone?: string | null
}

export interface TikTokReadingAdvertiserFailure extends TikTokReadingAdvertiser {
  error: ReadingErrorCode
  detail?: string
}

export interface TikTokReadingTopCampaign {
  key?: string
  name: string
  spend: number
  impressions: number
  clicks: number
  conversions: number
}

export interface TikTokReadingTotals {
  spend: number | null
  impressions: number
  clicks: number
  /** 点击率，小数（0.0123 = 1.23%），由点击/展示重新计算而非逐行求平均。 */
  ctr: number
  conversions: number
  /** 转化成本 = 消耗 / 转化；无转化时为 0。 */
  costPerConversion: number | null
}

export interface TikTokReadingSummary {
  /** The application-owned official connector serving this reading. */
  transport?: 'mcp'
  /** Persisting the shared dataset can fail independently of the live reading. */
  datasetSync?: { ok: true; legacyBackups?: string[]; proofs?: TikTokDatasetProof[] } | { ok: false; error: string }
  /** Per-account today windows; never assume all account calendars coincide. */
  accountWindows?: Array<{ advertiserId: string; timezone: string; startDate: string; endDate: string }>
  /** The selected account scope exceeded this widget's read cap. */
  truncated?: boolean
  range: TikTokReadingRange
  startDate: string
  endDate: string
  totals: TikTokReadingTotals
  /** 按消耗降序，最多 5 条。 */
  topCampaigns: TikTokReadingTopCampaign[]
  /** Credential origin; new MCP readings use the managed OAuth connection. */
  source: 'oauth' | 'pasted'
  generatedAt: number
  /** Accounts whose report is inside the totals. */
  advertisers: TikTokReadingAdvertiser[]
  /** Accounts that failed on their own; their numbers are NOT in the totals. */
  failed: TikTokReadingAdvertiserFailure[]
  /** The one currency every read account reports; null when unknown or mixed. */
  currency: string | null
  /** Accounts report different currencies, so money totals are not added up. */
  mixedCurrency: boolean
}

/** 成功返回汇总本身；失败时 error 是稳定的错误码，detail 是原始信息。 */
export type TikTokReadingResult = TikTokReadingSummary | ReadingFailure

function formatGrouped(value: number, digits: number): string {
  const negative = value < 0
  const [whole, fraction] = Math.abs(value).toFixed(digits).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fraction !== undefined ? `${grouped}.${fraction}` : grouped
  return negative ? `-${body}` : body
}

/** Account-currency amount. No currency symbol — the report does not carry one. */
export function formatTikTokAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return formatGrouped(value, 2)
}

export function formatTikTokCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return formatGrouped(Math.round(value), 0)
}

/** Click rate from summed counts. Zero impressions is missing, not 0%. */
export function formatTikTokRate(clicks: number, impressions: number): string {
  if (!(impressions > 0) || !Number.isFinite(clicks)) return '—'
  return `${((clicks / impressions) * 100).toFixed(2)}%`
}

/** Cost per conversion. Zero conversions is missing, not a $0 result. */
export function formatTikTokCostPerConversion(spend: number, conversions: number): string {
  if (!(conversions > 0) || !Number.isFinite(spend)) return '—'
  return formatTikTokAmount(spend / conversions)
}

export function isTikTokReadingRange(value: unknown): value is TikTokReadingRange {
  return value === '1' || value === 'yd' || value === '3' || value === '7' || value === '28' || value === '30'
}
