import { isMetaAccountId, isMetaReadingRange, type MetaReadingAccount, type MetaReadingRange, type MetaReadingSummary } from '../../../shared/metaReading'

export class MetaBoardReadError extends Error {}

type Obj = Record<string, unknown>
type Client = { callReadTool(name: string, args: Obj): Promise<Obj> }
const object = (v: unknown): Obj | null => !!v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null
const presets: Record<MetaReadingRange, string> = { today: 'today', yesterday: 'yesterday', last3: 'last_3d', last7: 'last_7d', last30: 'last_30d' }

/** Only parse structured JSON tool results. Never return upstream errors, links or arbitrary fields to IPC. */
export function metaToolData(result: Obj): Obj {
  if (result.isError) throw new MetaBoardReadError('Meta 查询失败，请检查连接、账户权限或服务额度。')
  let payload = object(result.structuredContent)
  // FastMCP wraps string-returning tools in structuredContent.result; the
  // text block contains the same JSON. Unwrap only this known container.
  if (payload && Object.keys(payload).length === 1 && 'result' in payload) {
    const wrapped = payload.result
    try { payload = typeof wrapped === 'string' ? object(JSON.parse(wrapped)) : object(wrapped) } catch { payload = null }
  }
  if (!payload && Array.isArray(result.content)) {
    const blocks = result.content.map(object).filter((block): block is Obj => !!block && block.type === 'text')
    if (blocks.length === 1 && typeof blocks[0].text === 'string') {
      try { payload = object(JSON.parse(blocks[0].text)) } catch { /* fail closed */ }
    }
  }
  if (!payload || payload.error || (!Array.isArray(payload.data) && !Array.isArray(payload.segmented_metrics))) throw new MetaBoardReadError('Meta 返回的数据格式不可用，请重试或检查服务额度。')
  return payload
}

function text(value: unknown, limit = 160): string | null {
  return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value : null
}
export async function readMetaAccounts(client: Client): Promise<{ accounts: MetaReadingAccount[]; partial: boolean }> {
  const payload = metaToolData(await client.callReadTool('get_ad_accounts', { limit: 200 }))
  if (!Array.isArray(payload.data)) throw new MetaBoardReadError('Meta 账户列表格式不可用。')
  const seen = new Set<string>()
  const accounts: MetaReadingAccount[] = []
  for (const raw of payload.data as unknown[]) {
    const row = object(raw)
    if (!row || !isMetaAccountId(row.id) || seen.has(row.id)) throw new MetaBoardReadError('Meta 账户列表格式不可用。')
    seen.add(row.id)
    accounts.push({ id: row.id, name: text(row.name) || row.id, currency: typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null, timezone: text(row.timezone_name) })
  }
  if (accounts.length > 200) throw new MetaBoardReadError('Meta 账户列表超出读取上限。')
  return { accounts, partial: !!object(payload.paging)?.next }
}
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
function metric(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value))) throw new MetaBoardReadError('Meta 指标格式不可用。')
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new MetaBoardReadError('Meta 指标格式不可用。')
  return n
}

/** Hosted Pipeboard daily responses are segmented reports, not raw Graph pages. */
export function metaDailyRows(payload: Obj, accountId: string): unknown[] {
  if (payload.truncated || payload.partial || (Array.isArray(payload.warnings) && payload.warnings.length > 0)) throw new MetaBoardReadError('Meta 报表包含不完整或警告结果。')
  if (Array.isArray(payload.data)) return payload.data
  if (payload.object_id !== accountId || payload.level !== 'account' || payload.time_breakdown !== 'day' || !Array.isArray(payload.segmented_metrics) || payload.total_segments !== payload.segmented_metrics.length) throw new MetaBoardReadError('Meta 分段报表范围或完整性不可用。')
  const window = object(payload.time_range)
  if (!window || !date(window.since) || !date(window.until) || window.since > window.until) throw new MetaBoardReadError('Meta 分段报表缺少日期范围。')
  const seen = new Set<string>()
  return payload.segmented_metrics.flatMap(raw => {
    const segment = object(raw), metrics = object(segment?.metrics)
    if (!segment || !metrics || !date(segment.period_start) || segment.period_start !== segment.period_end || seen.has(segment.period_start) || segment.period_start < window.since! || segment.period_start > window.until!) throw new MetaBoardReadError('Meta 每日分段格式不可用。')
    seen.add(segment.period_start)
    // Retain empty days as unknown values. Dropping them would let callers
    // present a partial sum as the total for the entire requested window.
    if (Object.keys(metrics).length === 0) return [{ account_id: accountId.slice(4), date_start: segment.period_start, date_stop: segment.period_end }]
    if (metrics.date_start !== segment.period_start || metrics.date_stop !== segment.period_end) throw new MetaBoardReadError('Meta 每日分段日期不匹配。')
    return [metrics]
  })
}

/** One selected account, daily account-level rows, bounded cursor pagination; incomplete results never become a summary. */
export async function readMetaSummary(client: Client, account: MetaReadingAccount, range: MetaReadingRange, window?: { start: string; end: string }): Promise<MetaReadingSummary> {
  if (!isMetaAccountId(account.id) || !isMetaReadingRange(range)) throw new MetaBoardReadError('请选择有效的 Meta 账户和日期范围。')
  if (window && (!date(window.start) || !date(window.end) || window.start > window.end)) throw new MetaBoardReadError('请选择有效的 Meta 日期范围。')
  const rows: MetaReadingSummary['rows'] = []
  const seen = new Set<string>()
  const days = new Set<string>()
  let after: string | undefined
  for (let page = 0; page < 5; page++) {
    const payload = metaToolData(await client.callReadTool('get_insights', { object_id: account.id, level: 'account', time_range: window ? { since: window.start, until: window.end } : presets[range], time_breakdown: 'day', limit: 100, ...(after ? { after } : {}) }))
    for (const raw of metaDailyRows(payload, account.id)) {
      const row = object(raw)
      if (!row || String(row.account_id) !== account.id.slice(4) || !date(row.date_start) || row.date_stop !== row.date_start || days.has(row.date_start)) throw new MetaBoardReadError('Meta 返回了不匹配的账户或非每日明细，未采用本次结果。')
      if (window && (row.date_start < window.start || row.date_start > window.end)) throw new MetaBoardReadError('Meta 返回的日期不在本次请求范围内。')
      days.add(row.date_start)
      rows.push({ date: row.date_start, spend: metric(row.spend), impressions: metric(row.impressions), clicks: metric(row.clicks) })
      if (rows.length > 31) throw new MetaBoardReadError('Meta 返回的日期范围超出限制。')
    }
    const paging = object(payload.paging)
    if (!paging?.next) {
      rows.sort((a, b) => a.date.localeCompare(b.date))
      const maxDays = range === 'last30' ? 30 : range === 'last7' ? 7 : range === 'last3' ? 3 : 1
      if (rows.length && (Date.parse(rows.at(-1)!.date) - Date.parse(rows[0].date)) / 86400000 >= maxDays) throw new MetaBoardReadError('Meta 返回的日期范围与请求不匹配。')
      return { account, range, rows, readAt: Date.now(), start: window?.start ?? rows[0]?.date ?? null, end: window?.end ?? rows.at(-1)?.date ?? null }
    }
    const cursor = object(paging.cursors)?.after
    if (typeof cursor !== 'string' || !cursor || cursor.length > 4000 || seen.has(cursor)) throw new MetaBoardReadError('Meta 分页未完整返回，未采用本次结果。')
    after = cursor; seen.add(cursor)
  }
  throw new MetaBoardReadError('Meta 分页超出限制，未采用本次结果。')
}
