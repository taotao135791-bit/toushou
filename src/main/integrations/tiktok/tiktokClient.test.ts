import { describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizeUrl,
  fetchAccessToken,
  fetchIntegratedReport,
  normalizeReportList,
  refreshAccessToken,
  sortRowsByDateDesc,
  TikTokApiError,
  TIKTOK_REPORT_METRICS
} from './tiktokClient'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function makeFetch(responder: (url: string, init?: RequestInit) => Response): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return responder(url, init)
  })
  return { fetch: fetch as (url: string, init?: RequestInit) => Promise<Response>, calls }
}

describe('oauth token exchange', () => {
  it('exchanges an auth_code and parses advertiser ids', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          access_token: 'at-1',
          expires_in: 86400,
          refresh_token: 'rt-1',
          refresh_token_expires_in: 31536000,
          advertiser_ids: ['7300001', 7300002],
          scope: 'AD_REPORT'
        }
      })
    )
    const tokens = await fetchAccessToken(fetch, { appId: '731', appSecret: 'sec', authCode: 'code-1' })
    expect(tokens.accessToken).toBe('at-1')
    expect(tokens.expiresIn).toBe(86400)
    expect(tokens.advertiserIds).toEqual([7300001, 7300002])
    expect(tokens.refreshTokenExpiresIn).toBe(31536000)

    const request = JSON.parse(String(calls[0].init?.body))
    expect(calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/')
    expect(request).toEqual({ app_id: '731', secret: 'sec', auth_code: 'code-1' })
  })

  it('refreshes a token via the refresh endpoint', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ code: 0, message: 'OK', data: { access_token: 'at-2', expires_in: 86400, advertiser_ids: [] } })
    )
    const tokens = await refreshAccessToken(fetch, { appId: '731', appSecret: 'sec', refreshToken: 'rt-old' })
    expect(tokens.accessToken).toBe('at-2')
    const request = JSON.parse(String(calls[0].init?.body))
    expect(calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/oauth2/refresh_token/')
    expect(request).toEqual({ app_id: '731', secret: 'sec', refresh_token: 'rt-old' })
  })

  it('throws a TikTokApiError when the envelope code !== 0', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({ code: 40105, message: 'Authentication failed', data: {} }, 200)
    )
    await expect(fetchAccessToken(fetch, { appId: '731', appSecret: 'bad', authCode: 'x' })).rejects.toThrowError(
      TikTokApiError
    )
    await expect(refreshAccessToken(fetch, { appId: '731', appSecret: 'bad', refreshToken: 'x' })).rejects.toMatchObject({
      code: 40105
    })
  })

  it('builds the authorize URL with app_id / redirect_uri / state', () => {
    const url = new URL(buildAuthorizeUrl('731', 'http://localhost:8789/callback', 'st-1'))
    expect(url.searchParams.get('app_id')).toBe('731')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8789/callback')
    expect(url.searchParams.get('state')).toBe('st-1')
  })
})

describe('integrated report', () => {
  it('requests BASIC AUCTION_CAMPAIGN with the documented dimensions/metrics and Access-Token header', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ code: 0, message: 'OK', data: { list: [], page_info: { total_page: 1 } } })
    )
    await fetchIntegratedReport(fetch, { accessToken: 'tok', startDate: '2026-01-01', endDate: '2026-01-07' })
    const { url, init } = calls[0]
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
    expect((init?.headers as Record<string, string>)['Access-Token']).toBe('tok')
    const body = JSON.parse(String(init?.body))
    expect(body.report_type).toBe('BASIC')
    expect(body.data_level).toBe('AUCTION_CAMPAIGN')
    expect(body.dimensions).toEqual(['stat_time_day', 'campaign_name'])
    expect(body.metrics).toEqual([...TIKTOK_REPORT_METRICS])
    expect(body.start_date).toBe('2026-01-01')
    expect(body.end_date).toBe('2026-01-07')
    expect(body.page).toBe(1)
    expect(body.page_size).toBe(200)
  })

  it('paginates until total_page is exhausted and merges rows', async () => {
    const { fetch, calls } = makeFetch((_url, init) => {
      const page = JSON.parse(String(init?.body)).page
      return jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          list:
            page === 1
              ? [
                  {
                    dimensions: { stat_time_day: '2026-01-02', campaign_name: 'C1' },
                    metrics: { spend: '10.5', impressions: '100', clicks: '5', ctr: '0.05', cpc: '2.1', conversion: '1', cost_per_conversion: '10.5' }
                  }
                ]
              : [
                  {
                    dimensions: { stat_time_day: '2026-01-01', campaign_name: 'C2' },
                    metrics: { spend: '20', impressions: '200', clicks: '9', ctr: '0.045', cpc: '2.22', conversion: '2', cost_per_conversion: '10' }
                  }
                ],
          page_info: { total_page: 2 }
        }
      })
    })
    const rows = await fetchIntegratedReport(fetch, { accessToken: 'tok', startDate: '2026-01-01', endDate: '2026-01-07' })
    expect(calls).toHaveLength(2)
    expect(rows.map((row) => row.campaignName)).toEqual(['C1', 'C2']) // date desc
    expect(rows[0].spend).toBeCloseTo(10.5)
  })

  it('supports the advertiser_id scope in the request body', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ code: 0, message: 'OK', data: { list: [], page_info: { total_page: 1 } } })
    )
    await fetchIntegratedReport(fetch, {
      accessToken: 'tok',
      startDate: '2026-01-01',
      endDate: '2026-01-07',
      advertiserId: 7300001
    })
    expect(JSON.parse(String(calls[0].init?.body)).advertiser_id).toBe(7300001)
  })

  it('surfaces the API error message when code !== 0', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({ code: 40100, message: 'Invalid access token', data: {} })
    )
    await expect(
      fetchIntegratedReport(fetch, { accessToken: 'expired', startDate: '2026-01-01', endDate: '2026-01-07' })
    ).rejects.toMatchObject({ code: 40100 })
  })
})

describe('normalization', () => {
  it('maps dimensions/metrics to typed rows; unparseable numbers become null', () => {
    const rows = normalizeReportList({
      list: [
        {
          dimensions: { stat_time_day: '2026/1/2', campaign_name: '夏日促销' },
          metrics: { spend: '¥1,234.56', impressions: '1,000', clicks: '', ctr: '5%', conversion: '3' }
        },
        { dimensions: { stat_time_day: 'not-a-date', campaign_name: 'x' }, metrics: {} }
      ]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      date: '2026-01-02',
      campaignName: '夏日促销',
      spend: 1234.56,
      impressions: 1000,
      clicks: null,
      ctr: 5,
      cpc: null,
      conversion: 3,
      costPerConversion: null
    })
  })

  it('sorts rows by date descending', () => {
    const sorted = sortRowsByDateDesc([
      { date: '2026-01-03', campaignName: 'a', spend: 1, impressions: null, clicks: null, ctr: null, cpc: null, conversion: null, costPerConversion: null },
      { date: '2026-01-05', campaignName: 'b', spend: 2, impressions: null, clicks: null, ctr: null, cpc: null, conversion: null, costPerConversion: null },
      { date: '2026-01-01', campaignName: 'c', spend: 3, impressions: null, clicks: null, ctr: null, cpc: null, conversion: null, costPerConversion: null }
    ])
    expect(sorted.map((row) => row.campaignName)).toEqual(['b', 'a', 'c'])
  })
})
