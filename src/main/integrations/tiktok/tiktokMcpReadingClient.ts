import { normalizeTikTokAdvertiserId } from '../../../shared/tiktokReport'
import { proxyFetchFor } from './proxyFetch'
import { normalizeReportList, TikTokApiError, type TikTokApiFetch, type TikTokReportRow } from './tiktokClient'

/** The application's own first-party MCP connection; no Open API fallback. */
const ENDPOINT = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer'
const PROTOCOL = '2025-03-26'
const READ_TOOLS = ['auth_advertiser_get', 'advertiser_info_get', 'report_integrated_get'] as const
type ReadTool = typeof READ_TOOLS[number]
type ObjectValue = Record<string, unknown>
const asObject = (value: unknown): ObjectValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null

/** Stateless request functions share a server session and are restricted to three read tools. */
export class TikTokMcpReadingClient {
  private session: string | null = null
  private version = PROTOCOL
  private id = 0
  private available = new Set<string>()
  constructor(private readonly token: string, private readonly fetchImpl: TikTokApiFetch = async (url, init) => (await proxyFetchFor(url, 'tiktok-api'))(url, init)) {}

  private async send(method: string, params: ObjectValue, notification = false): Promise<ObjectValue> {
    const id = ++this.id
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.version
    const response = await this.fetchImpl(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new TikTokApiError(response.status === 401 ? 40100 : response.status === 403 ? 40001 : response.status === 429 ? 40131 : -1, `TikTok MCP HTTP ${response.status}`)
    this.session = response.headers.get('mcp-session-id') ?? this.session
    if (notification) return {}
    const text = await response.text()
    let payload: unknown
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const messages = text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean)
        payload = messages.map((message) => JSON.parse(message)).find((item) => item.id === id)
      } else payload = JSON.parse(text)
    } catch { throw new TikTokApiError(-1, 'TikTok MCP 返回无效响应') }
    const message = asObject(payload)
    if (!message || message.jsonrpc !== '2.0' || message.id !== id) throw new TikTokApiError(-1, 'TikTok MCP 响应与请求不匹配')
    if (message.error) throw new TikTokApiError(-1, 'TikTok MCP 请求失败')
    const result = asObject(message.result)
    if (!result) throw new TikTokApiError(-1, 'TikTok MCP 响应缺少结果')
    return result
  }

  async initialize(): Promise<void> {
    const result = await this.send('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'toushou-readings', version: '1.0.0' } })
    if (typeof result.protocolVersion !== 'string') throw new TikTokApiError(-1, 'TikTok MCP 协议初始化失败')
    this.version = result.protocolVersion
    await this.send('notifications/initialized', {}, true)
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 20; page++) {
      const listing = await this.send('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(listing.tools)) throw new TikTokApiError(-1, 'TikTok MCP 工具列表无效')
      for (const raw of listing.tools) {
        const tool = asObject(raw)
        if (typeof tool?.name === 'string' && READ_TOOLS.includes(tool.name as ReadTool)) this.available.add(tool.name)
      }
      if (listing.nextCursor === undefined || listing.nextCursor === null || listing.nextCursor === '') return
      if (typeof listing.nextCursor !== 'string' || seen.has(listing.nextCursor)) throw new TikTokApiError(-1, 'TikTok MCP 工具列表分页无效')
      cursor = listing.nextCursor
      seen.add(cursor)
    }
    throw new TikTokApiError(-1, 'TikTok MCP 工具列表超过分页上限')
  }

  private async call(name: ReadTool, args: ObjectValue): Promise<ObjectValue> {
    if (!this.available.has(name)) throw new TikTokApiError(-1, `TikTok MCP 缺少只读工具 ${name}`)
    const result = await this.send('tools/call', { name, arguments: args })
    if (result.isError) throw new TikTokApiError(-1, `TikTok MCP 工具 ${name} 调用失败`)
    let value: unknown = result.structuredContent
    if (!value && Array.isArray(result.content)) {
      const content = result.content.map(asObject).find((item) => item?.type === 'text' && typeof item.text === 'string')
      if (content && typeof content.text === 'string') {
        try { value = JSON.parse(content.text) } catch { throw new TikTokApiError(-1, `TikTok MCP 工具 ${name} 返回非 JSON`) }
      }
    }
    let object = asObject(value)
    if (!object) throw new TikTokApiError(-1, `TikTok MCP 工具 ${name} 响应无效`)
    // Some servers wrap the provider envelope in a result property.
    if (asObject(object.result) && object.code === undefined && object.data === undefined) object = asObject(object.result)!
    if (object.code !== undefined && Number(object.code) !== 0) {
      const code = Number(object.code)
      const safeCode = Number.isSafeInteger(code) ? code : -1
      throw new TikTokApiError(safeCode, `TikTok MCP ${name} provider code ${safeCode}`)
    }
    if (object.success === false) throw new TikTokApiError(-1, `TikTok MCP 工具 ${name} 返回失败`)
    return asObject(object.data) ?? object
  }

  async advertisers(): Promise<string[]> {
    const data = await this.call('auth_advertiser_get', {})
    if (!Array.isArray(data.list)) throw new TikTokApiError(-1, 'TikTok MCP 广告主列表无效')
    const ids = data.list.map((raw) => normalizeTikTokAdvertiserId(asObject(raw)?.advertiser_id)).filter((id): id is string => !!id)
    return [...new Set(ids)]
  }

  async info(ids: string[]): Promise<Array<{ advertiserId: string; name: string | null; currency: string | null; timezone?: string | null }>> {
    const data = await this.call('advertiser_info_get', { advertiser_ids: ids, fields: ['advertiser_id', 'name', 'currency', 'timezone'] })
    if (!Array.isArray(data.list)) throw new TikTokApiError(-1, 'TikTok MCP 广告主信息无效')
    return data.list.flatMap((raw) => {
      const item = asObject(raw)
      const id = normalizeTikTokAdvertiserId(item?.advertiser_id)
      if (!id || !ids.includes(id)) return []
      return [{ advertiserId: id, name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : null, currency: typeof item?.currency === 'string' && /^[A-Z]{3}$/.test(item.currency.trim()) ? item.currency.trim() : null, ...(typeof item?.timezone === 'string' && item.timezone.trim() && item.timezone.length <= 100 ? { timezone: item.timezone.trim() } : {}) }]
    })
  }

  async report(advertiserId: string, startDate: string, endDate: string): Promise<TikTokReportRow[]> {
    const rows: TikTokReportRow[] = []
    const seenRows = new Set<string>()
    // TikTok's stat_time_day limit is 30 days; compare windows can span 56.
    let start = Date.parse(`${startDate}T00:00:00Z`)
    const end = Date.parse(`${endDate}T00:00:00Z`)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new TikTokApiError(-1, 'TikTok MCP 日期范围无效')
    while (start <= end) {
      const segmentEnd = Math.min(end, start + 29 * 86_400_000)
      const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      let complete = false
      let expectedPages: number | null = null
      let expectedRows: number | null = null
      let segmentRows = 0
      for (let page = 1; page <= 100; page++) {
        const data = await this.call('report_integrated_get', { advertiser_id: advertiserId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id', 'stat_time_day'], metrics: ['campaign_name', 'spend', 'impressions', 'clicks', 'conversion'], start_date: date(start), end_date: date(segmentEnd), page, page_size: 200 })
        if (!Array.isArray(data.list)) throw new TikTokApiError(-1, 'TikTok MCP 报表列表无效')
        const normalized = normalizeReportList(data)
        if (normalized.length !== data.list.length) throw new TikTokApiError(-1, 'TikTok MCP 报表行格式无效')
        for (let i = 0; i < normalized.length; i++) {
          const row = normalized[i]
          const dimensions = asObject(asObject(data.list[i])?.dimensions)
          const campaignId = dimensions?.campaign_id
          if (typeof campaignId !== 'string' || !/^[1-9]\d{0,24}$/.test(campaignId) || row.date < date(start) || row.date > date(segmentEnd) || [row.spend, row.impressions, row.clicks, row.conversion].some((n) => n === null || !Number.isFinite(n) || n < 0)) {
            throw new TikTokApiError(-1, 'TikTok MCP 报表行缺少有效标识、日期或指标')
          }
          const key = `${campaignId}:${row.date}`
          if (seenRows.has(key)) throw new TikTokApiError(-1, 'TikTok MCP 报表存在重复行')
          seenRows.add(key)
          rows.push({ ...row, advertiserId, campaignId })
        }
        segmentRows += data.list.length
        const info = asObject(data.page_info)
        const total = info?.total_page === undefined ? null : Number(info.total_page)
        const totalRows = info?.total_number === undefined ? null : Number(info.total_number)
        if (totalRows !== null && (!Number.isSafeInteger(totalRows) || totalRows < 0 || totalRows > 20_000)) throw new TikTokApiError(-1, 'TikTok MCP 报表结果超过安全范围')
        if (total !== null && (!Number.isInteger(total) || total < 0)) throw new TikTokApiError(-1, 'TikTok MCP 报表分页无效')
        if (info?.page !== undefined && Number(info.page) !== page) throw new TikTokApiError(-1, 'TikTok MCP 报表页码不一致')
        if (page > 1 && (total !== expectedPages || totalRows !== expectedRows)) throw new TikTokApiError(-1, 'TikTok MCP 报表分页元数据不一致')
        if (page === 1) { expectedPages = total; expectedRows = totalRows }
        if (total !== null && data.list.length === 0 && (page < total || page > 1)) throw new TikTokApiError(-1, 'TikTok MCP 报表提前出现空页')
        if ((total !== null && page >= Math.max(1, total)) || (total === null && data.list.length < 200)) {
          if (expectedRows !== null && segmentRows !== expectedRows) throw new TikTokApiError(-1, 'TikTok MCP 报表行数不完整')
          complete = true; break
        }
      }
      if (!complete) throw new TikTokApiError(-1, 'TikTok MCP 报表超过分页上限')
      start = segmentEnd + 86_400_000
    }
    return rows
  }
}
