import { cleanNumberString, parseDateString } from '../../../shared/datasets'
import { READING_ERROR_DETAIL_LIMIT, type ReadingErrorCode } from '../../../shared/readingError'
import { normalizeTikTokAdvertiserId, normalizeTikTokAdvertiserIds } from '../../../shared/tiktokReport'

/**
 * TikTok Business API (Open API v1.3) 客户端 — OAuth 换取/刷新、集成报表、
 * 广告主信息。
 *
 * 全部网络细节收敛在这里：Main 的其它模块只面对 fetchAccessToken /
 * refreshAccessToken / fetchIntegratedReport / fetchAdvertiserInfo 几个入口。
 * fetch 可注入，测试不需要真实网络。
 */

export type TikTokApiFetch = (url: string, init?: RequestInit) => Promise<Response>

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3'
export const TIKTOK_AUTHORIZE_URL = 'https://business-api.tiktok.com/open_api/v1.3/oauth2/authorize'
const ACCESS_TOKEN_URL = `${API_BASE}/oauth2/access_token/`
const REFRESH_TOKEN_URL = `${API_BASE}/oauth2/refresh_token/`
const INTEGRATED_REPORT_URL = `${API_BASE}/report/integrated/get/`
const ADVERTISER_INFO_URL = `${API_BASE}/advertiser/info/`

/**
 * Report request contract (v1.3 integrated, BASIC). The endpoint is GET with
 * JSON-encoded arrays in the query string; a POST gets an HTML 405.
 * campaign_name is an attribute metric, not a dimension, so rows are keyed by
 * campaign_id × stat_time_day.
 */
export const TIKTOK_REPORT_METRICS = [
  'campaign_name',
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'conversion',
  'cost_per_conversion'
] as const

export const TIKTOK_REPORT_DIMENSIONS = ['campaign_id', 'stat_time_day'] as const

const DATA_LEVEL = 'AUCTION_CAMPAIGN'
const PAGE_SIZE = 200
/** Hard cap so a hostile/misread page_info can never loop forever. */
const MAX_PAGES = 100
const REQUEST_TIMEOUT_MS = 20_000
/** advertiser/info/ accepts at most 100 ids per call. */
const ADVERTISER_INFO_BATCH = 100

/** TikTok envelope: code === 0 means success; anything else carries message. */
export class TikTokApiError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'TikTokApiError'
    this.code = code
  }
}

export interface TikTokTokenResult {
  accessToken: string
  /** Seconds per API; stored normalized to epoch ms by the caller. */
  expiresIn?: number
  refreshToken?: string
  refreshTokenExpiresIn?: number
  advertiserIds: string[]
  scope?: string
}

function assertEnvelope(payload: Record<string, unknown>, what: string): Record<string, unknown> {
  const code = typeof payload.code === 'number' ? payload.code : Number.NaN
  if (code !== 0) {
    const message = typeof payload.message === 'string' && payload.message ? payload.message : 'unknown error'
    throw new TikTokApiError(code, `${what}失败（code=${payload.code}）：${message}`)
  }
  const data = payload.data
  if (!data || typeof data !== 'object') {
    throw new TikTokApiError(code, `${what}失败：响应缺少 data`)
  }
  return data as Record<string, unknown>
}

async function postJson(
  fetchImpl: TikTokApiFetch,
  url: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    throw new TikTokApiError(-1, `${url} 返回的不是 JSON（HTTP ${response.status}）`)
  }
  return payload
}

async function getJson(
  fetchImpl: TikTokApiFetch,
  url: URL,
  accessToken: string,
  what: string
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json', 'Access-Token': accessToken },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new TikTokApiError(-1, `${what}返回的不是 JSON（HTTP ${response.status}）`)
  }
}

function tokenFromData(data: Record<string, unknown>): TikTokTokenResult {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (!accessToken) throw new TikTokApiError(-1, 'TikTok 响应缺少 access_token')
  return {
    accessToken,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshTokenExpiresIn: typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : undefined,
    advertiserIds: normalizeTikTokAdvertiserIds(data.advertiser_ids),
    scope: typeof data.scope === 'string' ? data.scope : undefined
  }
}

export interface TikTokTokenCall {
  appId: string
  appSecret: string
}

/**
 * OAuth2 auth_code exchange: POST /oauth2/access_token/ {app_id, secret,
 * auth_code}. Access tokens live ~24h; refresh tokens ~1 year.
 */
export async function fetchAccessToken(
  fetchImpl: TikTokApiFetch,
  call: TikTokTokenCall & { authCode: string }
): Promise<TikTokTokenResult> {
  const payload = await postJson(fetchImpl, ACCESS_TOKEN_URL, {
    app_id: call.appId,
    secret: call.appSecret,
    auth_code: call.authCode
  })
  return tokenFromData(assertEnvelope(payload, '获取 access_token'))
}

/** Long-lived use: POST /oauth2/refresh_token/ {app_id, secret, refresh_token}. */
export async function refreshAccessToken(
  fetchImpl: TikTokApiFetch,
  call: TikTokTokenCall & { refreshToken: string }
): Promise<TikTokTokenResult> {
  const payload = await postJson(fetchImpl, REFRESH_TOKEN_URL, {
    app_id: call.appId,
    secret: call.appSecret,
    refresh_token: call.refreshToken
  })
  return tokenFromData(assertEnvelope(payload, '刷新 access_token'))
}

/** Build the browser authorize URL for a registered developer app. */
export function buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

// ---------------------------------------------------------------------------
// Integrated report — BASIC / campaign_id × stat_time_day, paged.
// ---------------------------------------------------------------------------

export interface TikTokReportRow {
  /** YYYY-MM-DD (already normalized). */
  date: string
  campaignName: string
  spend: number | null
  impressions: number | null
  clicks: number | null
  /** Click-through rate as TikTok reports it. */
  ctr: number | null
  /** Cost per click. */
  cpc: number | null
  conversion: number | null
  costPerConversion: number | null
}

export interface TikTokReportQuery {
  accessToken: string
  /** BASIC reports require it. A decimal string, never a JS number. */
  advertiserId: string
  startDate: string
  endDate: string
}

function toNumberCell(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  return cleanNumberString(value)
}

function textCell(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** stat_time_day arrives as "2026-01-02 00:00:00"; the day is the part before the time. */
function reportDay(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return parseDateString(value.trim().replace(/[ T]\d{2}:\d{2}(:\d{2})?$/, ''))
}

/**
 * Pure normalizer for one integrated-report page body → rows. exported for
 * tests; tolerant of missing metric cells (they become null → '' in the grid).
 */
export function normalizeReportList(data: Record<string, unknown>): TikTokReportRow[] {
  const list = Array.isArray(data.list) ? data.list : []
  const rows: TikTokReportRow[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const dimensions = (item.dimensions && typeof item.dimensions === 'object' ? item.dimensions : {}) as Record<string, unknown>
    const metrics = (item.metrics && typeof item.metrics === 'object' ? item.metrics : {}) as Record<string, unknown>
    const date = reportDay(dimensions.stat_time_day)
    if (!date) continue
    const campaignName =
      textCell(metrics.campaign_name) || textCell(dimensions.campaign_name) || textCell(dimensions.campaign_id)
    rows.push({
      date,
      campaignName,
      spend: toNumberCell(metrics.spend),
      impressions: toNumberCell(metrics.impressions),
      clicks: toNumberCell(metrics.clicks),
      ctr: toNumberCell(metrics.ctr),
      cpc: toNumberCell(metrics.cpc),
      conversion: toNumberCell(metrics.conversion),
      costPerConversion: toNumberCell(metrics.cost_per_conversion)
    })
  }
  return rows
}

/** Newest day first — the dataset writer keeps this order. */
export function sortRowsByDateDesc(rows: TikTokReportRow[]): TikTokReportRow[] {
  return [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/**
 * Fetch one advertiser's integrated report across ALL pages and return
 * normalized rows sorted by date desc. Throws TikTokApiError when the
 * envelope code !== 0.
 */
export async function fetchIntegratedReport(
  fetchImpl: TikTokApiFetch,
  query: TikTokReportQuery
): Promise<TikTokReportRow[]> {
  const advertiserId = normalizeTikTokAdvertiserId(query.advertiserId)
  if (!advertiserId) throw new TikTokApiError(-1, '报表接口需要广告主 ID（advertiser_id）')
  const rows: TikTokReportRow[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(INTEGRATED_REPORT_URL)
    url.searchParams.set('advertiser_id', advertiserId)
    url.searchParams.set('report_type', 'BASIC')
    url.searchParams.set('data_level', DATA_LEVEL)
    url.searchParams.set('dimensions', JSON.stringify(TIKTOK_REPORT_DIMENSIONS))
    url.searchParams.set('metrics', JSON.stringify(TIKTOK_REPORT_METRICS))
    url.searchParams.set('start_date', query.startDate)
    url.searchParams.set('end_date', query.endDate)
    url.searchParams.set('page', String(page))
    url.searchParams.set('page_size', String(PAGE_SIZE))
    const payload = await getJson(fetchImpl, url, query.accessToken, '报表接口')
    const data = assertEnvelope(payload, '拉取报表')
    rows.push(...normalizeReportList(data))
    const pageInfo = (data.page_info && typeof data.page_info === 'object' ? data.page_info : {}) as Record<string, unknown>
    const totalPages = typeof pageInfo.total_page === 'number' ? pageInfo.total_page : 1
    if (page >= Math.max(1, Math.min(totalPages, MAX_PAGES))) break
  }
  return sortRowsByDateDesc(rows)
}

// ---------------------------------------------------------------------------
// Advertiser info — names and currencies for display.
// ---------------------------------------------------------------------------

export interface TikTokAdvertiserInfo {
  advertiserId: string
  name: string | null
  currency: string | null
}

/** A numeric advertiser_id in JSON has already lost digits; match it the same lossy way. */
function matchRequestedId(value: unknown, requested: string[]): string | null {
  if (typeof value === 'string') {
    const id = value.trim()
    return requested.includes(id) ? id : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return requested.find((id) => Number(id) === value) ?? null
  }
  return null
}

/**
 * GET /advertiser/info/ for the given ids. Ids TikTok does not return are
 * absent from the result; the caller keeps showing the bare id for those.
 */
export async function fetchAdvertiserInfo(
  fetchImpl: TikTokApiFetch,
  query: { accessToken: string; advertiserIds: string[] }
): Promise<TikTokAdvertiserInfo[]> {
  const requested = normalizeTikTokAdvertiserIds(query.advertiserIds, Number.POSITIVE_INFINITY)
  const result: TikTokAdvertiserInfo[] = []
  for (let index = 0; index < requested.length; index += ADVERTISER_INFO_BATCH) {
    const batch = requested.slice(index, index + ADVERTISER_INFO_BATCH)
    const url = new URL(ADVERTISER_INFO_URL)
    url.searchParams.set('advertiser_ids', JSON.stringify(batch))
    url.searchParams.set('fields', JSON.stringify(['advertiser_id', 'name', 'currency']))
    const payload = await getJson(fetchImpl, url, query.accessToken, '广告主信息接口')
    const data = assertEnvelope(payload, '读取广告主信息')
    const list = Array.isArray(data.list) ? data.list : []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const advertiserId = matchRequestedId(item.advertiser_id, batch)
      if (!advertiserId || result.some((info) => info.advertiserId === advertiserId)) continue
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : null
      const currency =
        typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency.trim()) ? item.currency.trim() : null
      result.push({ advertiserId, name, currency })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Failure classification — one stable code per failure for the renderer.
// ---------------------------------------------------------------------------

/** Return codes TikTok documents for token, permission and frequency failures. */
const AUTH_CODES = new Set([40100, 40104, 40105])
const PERMISSION_CODES = new Set([40001])
const RATE_LIMIT_CODES = new Set([40131])

export function classifyTikTokError(error: unknown): { code: ReadingErrorCode; detail: string } {
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.slice(0, READING_ERROR_DETAIL_LIMIT)
  if (error instanceof TikTokApiError) {
    if (AUTH_CODES.has(error.code)) return { code: 'auth', detail }
    if (PERMISSION_CODES.has(error.code)) return { code: 'permission', detail }
    if (RATE_LIMIT_CODES.has(error.code)) return { code: 'rate-limit', detail }
    if (/permission|not authori[sz]ed/i.test(message)) return { code: 'permission', detail }
    if (/access.?token/i.test(message)) return { code: 'auth', detail }
    if (/too many|too frequent|rate limit/i.test(message)) return { code: 'rate-limit', detail }
    return { code: 'api', detail }
  }
  const name = error instanceof Error ? error.name : ''
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message)
  ) {
    return { code: 'network', detail }
  }
  return { code: 'api', detail }
}
