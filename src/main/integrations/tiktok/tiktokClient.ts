import { cleanNumberString, parseDateString } from '../../../shared/datasets'

/**
 * TikTok Business API (Open API v1.3) 客户端 — OAuth 换取/刷新 + 集成报表。
 *
 * 全部网络细节收敛在这里：Main 的其它模块只面对 fetchAccessToken /
 * refreshAccessToken / fetchIntegratedReport 三个入口。fetch 可注入，
 * 测试不需要真实网络。
 */

export type TikTokApiFetch = (url: string, init?: RequestInit) => Promise<Response>

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3'
export const TIKTOK_AUTHORIZE_URL = 'https://business-api.tiktok.com/open_api/v1.3/oauth2/authorize'
const ACCESS_TOKEN_URL = `${API_BASE}/oauth2/access_token/`
const REFRESH_TOKEN_URL = `${API_BASE}/oauth2/refresh_token/`
const INTEGRATED_REPORT_URL = `${API_BASE}/report/integrated/get/`

/** Report request contract (v1.3 integrated, BASIC). */
export const TIKTOK_REPORT_METRICS = [
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'conversion',
  'cost_per_conversion'
] as const

export const TIKTOK_REPORT_DIMENSIONS = ['stat_time_day', 'campaign_name'] as const

export type TikTokReportDataLevel = 'AUCTION_CAMPAIGN' | 'AUCTION_ADGROUP' | 'AUCTION_AD'
const DEFAULT_DATA_LEVEL: TikTokReportDataLevel = 'AUCTION_CAMPAIGN'
const PAGE_SIZE = 200
/** Hard cap so a hostile/misread page_info can never loop forever. */
const MAX_PAGES = 100
const REQUEST_TIMEOUT_MS = 20_000

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
  advertiserIds: number[]
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

function parseAdvertiserIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const ids: number[] = []
  for (const entry of value) {
    const id = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number.parseInt(entry, 10) : Number.NaN
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function tokenFromData(data: Record<string, unknown>): TikTokTokenResult {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (!accessToken) throw new TikTokApiError(-1, 'TikTok 响应缺少 access_token')
  return {
    accessToken,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshTokenExpiresIn: typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : undefined,
    advertiserIds: parseAdvertiserIds(data.advertiser_ids),
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
// Integrated report — BASIC / stat_time_day × campaign_name, paged.
// ---------------------------------------------------------------------------

export interface TikTokReportRow {
  /** YYYY-MM-DD (already normalized). */
  date: string
  campaignName: string
  spend: number | null
  impressions: number | null
  clicks: number | null
  /** Click-through rate, decimal (0.0123 = 1.23%). */
  ctr: number | null
  /** Cost per click. */
  cpc: number | null
  conversion: number | null
  costPerConversion: number | null
}

export interface TikTokReportQuery {
  accessToken: string
  startDate: string
  endDate: string
  dataLevel?: TikTokReportDataLevel
  /** Optional advertiser scope; omitted when absent (token-level scope). */
  advertiserId?: number
}

function toNumberCell(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  return cleanNumberString(value)
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
    const date = parseDateString(typeof dimensions.stat_time_day === 'string' ? dimensions.stat_time_day : '')
    if (!date) continue
    const campaignName = String(dimensions.campaign_name ?? '').trim()
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
 * Fetch the integrated report across ALL pages and return normalized rows
 * sorted by date desc. Throws TikTokApiError when the envelope code !== 0.
 */
export async function fetchIntegratedReport(
  fetchImpl: TikTokApiFetch,
  query: TikTokReportQuery
): Promise<TikTokReportRow[]> {
  const rows: TikTokReportRow[] = []
  const dataLevel = query.dataLevel ?? DEFAULT_DATA_LEVEL
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      report_type: 'BASIC',
      data_level: dataLevel,
      dimensions: TIKTOK_REPORT_DIMENSIONS,
      metrics: TIKTOK_REPORT_METRICS,
      start_date: query.startDate,
      end_date: query.endDate,
      page,
      page_size: PAGE_SIZE
    }
    if (query.advertiserId !== undefined) body.advertiser_id = query.advertiserId
    const response = await fetchImpl(INTEGRATED_REPORT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'Access-Token': query.accessToken
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    let payload: Record<string, unknown>
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      throw new TikTokApiError(-1, `报表接口返回的不是 JSON（HTTP ${response.status}）`)
    }
    const data = assertEnvelope(payload, '拉取报表')
    rows.push(...normalizeReportList(data))
    const pageInfo = (data.page_info && typeof data.page_info === 'object' ? data.page_info : {}) as Record<string, unknown>
    const totalPages = typeof pageInfo.total_page === 'number' ? pageInfo.total_page : 1
    if (page >= Math.max(1, Math.min(totalPages, MAX_PAGES))) break
  }
  return sortRowsByDateDesc(rows)
}
