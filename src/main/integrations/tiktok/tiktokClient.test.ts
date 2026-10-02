import { describe, expect, it, vi } from 'vitest'
import { READING_ERROR_DETAIL_LIMIT } from '../../../shared/readingError'
import {
  buildAuthorizeUrl,
  classifyTikTokError,
  fetchAccessToken,
  fetchAdvertiserInfo,
  fetchIntegratedReport,
  normalizeReportList,
  refreshAccessToken,
  sortRowsByDateDesc,
  TikTokApiError,
  TIKTOK_REPORT_DIMENSIONS,
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

/** 19 digits: past Number.MAX_SAFE_INTEGER, so it only survives as a string. */
const BIG_ID = '7300000000000000001'

const emptyReport = () => jsonResponse({ code: 0, message: 'OK', data: { list: [], page_info: { total_page: 1 } } })

describe('oauth token exchange', () => {
  it('exchanges an auth_code and parses advertiser ids as decimal strings', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          access_token: 'at-1',
          expires_in: 86400,
          refresh_token: 'rt-1',
          refresh_token_expires_in: 31536000,
          advertiser_ids: [BIG_ID, 7300002, Number(BIG_ID)],
          scope: 'AD_REPORT'
        }
      })
    )
    const tokens = await fetchAccessToken(fetch, { appId: '731', appSecret: 'sec', authCode: 'code-1' })
    expect(tokens.accessToken).toBe('at-1')
    expect(tokens.expiresIn).toBe(86400)
    // The unsafe JSON number has already lost digits, so it is dropped rather than guessed.
    expect(tokens.advertiserIds).toEqual([BIG_ID, '7300002'])
    expect(tokens.refreshTokenExpiresIn).toBe(31536000)

    const request = JSON.parse(String(calls[0].init?.body))
    expect(calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/')
    expect(calls[0].init?.method).toBe('POST')
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
    expect(calls[0].init?.method).toBe('POST')
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
  it('sends a GET with the documented query params and the Access-Token header', async () => {
    const { fetch, calls } = makeFetch(emptyReport)
    await fetchIntegratedReport(fetch, {
      accessToken: 'tok',
      advertiserId: BIG_ID,
      startDate: '2026-01-01',
      endDate: '2026-01-07'
    })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect((init?.headers as Record<string, string>)['Access-Token']).toBe('tok')

    const parsed = new URL(url)
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
    const params = parsed.searchParams
    expect(params.get('advertiser_id')).toBe(BIG_ID)
    expect(params.get('report_type')).toBe('BASIC')
    expect(params.get('data_level')).toBe('AUCTION_CAMPAIGN')
    expect(JSON.parse(params.get('dimensions') ?? 'null')).toEqual(['campaign_id', 'stat_time_day'])
    expect(JSON.parse(params.get('dimensions') ?? 'null')).toEqual([...TIKTOK_REPORT_DIMENSIONS])
    expect(JSON.parse(params.get('metrics') ?? 'null')).toEqual([...TIKTOK_REPORT_METRICS])
    expect(JSON.parse(params.get('metrics') ?? 'null')).toContain('campaign_name')
    expect(params.get('start_date')).toBe('2026-01-01')
    expect(params.get('end_date')).toBe('2026-01-07')
    expect(params.get('page')).toBe('1')
    expect(params.get('page_size')).toBe('200')
  })

  it('does not send anything without an advertiser id', async () => {
    const { fetch, calls } = makeFetch(emptyReport)
    for (const advertiserId of ['', '   ', 'abc', '0123']) {
      await expect(
        fetchIntegratedReport(fetch, { accessToken: 'tok', advertiserId, startDate: '2026-01-01', endDate: '2026-01-07' })
      ).rejects.toThrowError(TikTokApiError)
    }
    expect(calls).toHaveLength(0)
  })

  it('paginates until total_page is exhausted and merges rows', async () => {
    const { fetch, calls } = makeFetch((url) => {
      const page = new URL(url).searchParams.get('page')
      return jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          list:
            page === '1'
              ? [
                  {
                    dimensions: { campaign_id: '1801', stat_time_day: '2026-01-02 00:00:00' },
                    metrics: {
                      campaign_name: 'C1',
                      spend: '10.5',
                      impressions: '100',
                      clicks: '5',
                      ctr: '0.05',
                      cpc: '2.1',
                      conversion: '1',
                      cost_per_conversion: '10.5'
                    }
                  }
                ]
              : [
                  {
                    dimensions: { campaign_id: '1802', stat_time_day: '2026-01-01 00:00:00' },
                    metrics: {
                      campaign_name: 'C2',
                      spend: '20',
                      impressions: '200',
                      clicks: '9',
                      ctr: '0.045',
                      cpc: '2.22',
                      conversion: '2',
                      cost_per_conversion: '10'
                    }
                  }
                ],
          page_info: { total_page: 2 }
        }
      })
    })
    const rows = await fetchIntegratedReport(fetch, {
      accessToken: 'tok',
      advertiserId: BIG_ID,
      startDate: '2026-01-01',
      endDate: '2026-01-07'
    })
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => new URL(call.url).searchParams.get('page'))).toEqual(['1', '2'])
    expect(calls.every((call) => call.init?.method === 'GET')).toBe(true)
    expect(rows.map((row) => row.campaignName)).toEqual(['C1', 'C2']) // date desc
    expect(rows.map((row) => row.date)).toEqual(['2026-01-02', '2026-01-01'])
    expect(rows[0].spend).toBeCloseTo(10.5)
  })

  it('stops at the page cap even if total_page keeps growing', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ code: 0, message: 'OK', data: { list: [], page_info: { total_page: 10_000 } } })
    )
    await fetchIntegratedReport(fetch, { accessToken: 'tok', advertiserId: BIG_ID, startDate: '2026-01-01', endDate: '2026-01-07' })
    expect(calls).toHaveLength(100)
  })

  it('surfaces the API return code when code !== 0', async () => {
    const { fetch } = makeFetch(() => jsonResponse({ code: 40105, message: 'Access token is incorrect or has been revoked', data: {} }))
    await expect(
      fetchIntegratedReport(fetch, { accessToken: 'expired', advertiserId: BIG_ID, startDate: '2026-01-01', endDate: '2026-01-07' })
    ).rejects.toMatchObject({ code: 40105 })
  })

  it('reports an HTML answer (wrong method or gateway page) as a TikTokApiError', async () => {
    const { fetch } = makeFetch(() => new Response('<html>405 Not Allowed</html>', { status: 405 }))
    await expect(
      fetchIntegratedReport(fetch, { accessToken: 'tok', advertiserId: BIG_ID, startDate: '2026-01-01', endDate: '2026-01-07' })
    ).rejects.toMatchObject({ name: 'TikTokApiError', code: -1 })
  })
})

describe('advertiser info', () => {
  it('sends a GET with advertiser_ids and fields and returns names and currencies', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        code: 0,
        message: 'OK',
        data: {
          list: [
            { advertiser_id: BIG_ID, name: '  三国 iOS  ', currency: 'USD' },
            { advertiser_id: '7300002', name: '', currency: 'usd' },
            { advertiser_id: '9999', name: 'Not requested', currency: 'EUR' }
          ]
        }
      })
    )
    const info = await fetchAdvertiserInfo(fetch, { accessToken: 'tok', advertiserIds: [BIG_ID, '7300002'] })
    expect(info).toEqual([
      { advertiserId: BIG_ID, name: '三国 iOS', currency: 'USD' },
      { advertiserId: '7300002', name: null, currency: null }
    ])
    const { url, init } = calls[0]
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>)['Access-Token']).toBe('tok')
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/open_api/v1.3/advertiser/info/')
    expect(JSON.parse(parsed.searchParams.get('advertiser_ids') ?? 'null')).toEqual([BIG_ID, '7300002'])
    expect(JSON.parse(parsed.searchParams.get('fields') ?? 'null')).toEqual(['advertiser_id', 'name', 'currency'])
  })

  it('matches a numeric advertiser_id back to the requested string', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({ code: 0, message: 'OK', data: { list: [{ advertiser_id: Number(BIG_ID), name: 'Big', currency: 'JPY' }] } })
    )
    const info = await fetchAdvertiserInfo(fetch, { accessToken: 'tok', advertiserIds: [BIG_ID] })
    expect(info).toEqual([{ advertiserId: BIG_ID, name: 'Big', currency: 'JPY' }])
  })

  it('splits more than 100 ids into batches', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => String(7300000000 + index))
    const { fetch, calls } = makeFetch(() => jsonResponse({ code: 0, message: 'OK', data: { list: [] } }))
    await fetchAdvertiserInfo(fetch, { accessToken: 'tok', advertiserIds: ids })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(new URL(calls[0].url).searchParams.get('advertiser_ids') ?? '[]')).toHaveLength(100)
    expect(JSON.parse(new URL(calls[1].url).searchParams.get('advertiser_ids') ?? '[]')).toHaveLength(20)
  })

  it('sends nothing for an empty list', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ code: 0, message: 'OK', data: { list: [] } }))
    expect(await fetchAdvertiserInfo(fetch, { accessToken: 'tok', advertiserIds: [] })).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('error classification', () => {
  it('maps documented return codes to stable reading codes', () => {
    expect(classifyTikTokError(new TikTokApiError(40104, 'Access token is empty')).code).toBe('auth')
    expect(classifyTikTokError(new TikTokApiError(40105, 'revoked')).code).toBe('auth')
    expect(classifyTikTokError(new TikTokApiError(40001, 'No permission')).code).toBe('permission')
    expect(classifyTikTokError(new TikTokApiError(40100, 'Invalid access token')).code).toBe('auth')
    expect(classifyTikTokError(new TikTokApiError(40131, 'Too many requests')).code).toBe('rate-limit')
  })

  it('falls back to the message for undocumented codes', () => {
    expect(classifyTikTokError(new TikTokApiError(40102, 'The access token has expired')).code).toBe('auth')
    expect(classifyTikTokError(new TikTokApiError(40009, 'Advertiser is not authorized')).code).toBe('permission')
    expect(classifyTikTokError(new TikTokApiError(51000, 'Requests are too frequent')).code).toBe('rate-limit')
    expect(classifyTikTokError(new TikTokApiError(50000, 'System error')).code).toBe('api')
  })

  it('treats transport failures as network', () => {
    expect(classifyTikTokError(new TypeError('fetch failed')).code).toBe('network')
    expect(classifyTikTokError(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })).code).toBe('network')
    expect(classifyTikTokError(new Error('getaddrinfo ENOTFOUND business-api.tiktok.com')).code).toBe('network')
    expect(classifyTikTokError('weird').code).toBe('api')
  })

  it('keeps a bounded detail for the technical-details fold', () => {
    const result = classifyTikTokError(new TikTokApiError(50000, 'x'.repeat(READING_ERROR_DETAIL_LIMIT + 50)))
    expect(result.detail).toHaveLength(READING_ERROR_DETAIL_LIMIT)
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

  it('reads the day out of "YYYY-MM-DD 00:00:00" and the name out of metrics', () => {
    const rows = normalizeReportList({
      list: [
        { dimensions: { campaign_id: '1801', stat_time_day: '2026-03-04 00:00:00' }, metrics: { campaign_name: 'Spring', spend: '3' } },
        { dimensions: { campaign_id: '1802', stat_time_day: '2026-03-05T00:00' }, metrics: { spend: '4' } }
      ]
    })
    expect(rows.map((row) => [row.date, row.campaignName, row.spend])).toEqual([
      ['2026-03-04', 'Spring', 3],
      ['2026-03-05', '1802', 4]
    ])
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
