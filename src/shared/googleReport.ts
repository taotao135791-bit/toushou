import Papa from 'papaparse'

/** Google Ads CSV: preserve platform metric semantics and never infer missing scope. */
export const GOOGLE_REPORT_CONTRACT_VERSION = 1
export interface GoogleReportCampaign {
  name: string
  customFields?: Record<string, string[]>
  spend: number
  impressions: number | null
  clicks: number | null
  conversions: number | null
}
export interface GoogleReportAccount {
  accountId: string
  accountName: string | null
  currency: string
  spend: number
  impressions: number | null
  clicks: number | null
  conversions: number | null
  conversionValue: number | null
  campaigns: GoogleReportCampaign[]
}
export interface GoogleReportContext {
  accountId: string
  accountName: string | null
  currency: string
  timezone: string
  windowStart: string
  windowEnd: string
}
export interface GoogleReportSummary {
  timezone?: string
  windowStart: string
  windowEnd: string
  accounts: GoogleReportAccount[]
}
export interface GoogleReportParseOutcome {
  verification: { verified: boolean; errors: string[]; warnings: string[] }
  summary: GoogleReportSummary | null
}
export interface GoogleReportStoredReading {
  widgetId: string
  importedAt: number
  fileName: string
  sourceUrl?: string
  contractVersion: number
  summary: GoogleReportSummary
  warnings: string[]
}
export interface GoogleReportImportResult {
  ok: boolean
  canceled?: boolean
  error?: 'file-read-failed' | 'file-too-large' | 'file-empty' | 'invalid-widget'
  outcome?: GoogleReportParseOutcome
  reading?: GoogleReportStoredReading
}

const aliases: Record<string, string[]> = {
  accountId: ['customer id', 'account id', '客户 id', '客户id', '客户编号', '帐号 id', '账号 id', '账户 id', '帐号编号', '账号编号', '账户编号'],
  accountName: ['account', 'account name', 'customer', 'customer name', '帐号', '账号', '账户', '帐号名称', '账号名称', '账户名称', '客户名称'],
  campaign: ['campaign', 'campaign name', '广告系列', '广告系列名称'],
  currency: ['currency', 'currency code', '货币', '货币代码'],
  spend: ['cost', 'spend', '费用', '花费', '成本'],
  impressions: ['impressions', 'impr.', '展示次数', '展示'],
  clicks: ['clicks', '点击次数', '点击'],
  conversions: ['conversions', 'conv.', '转化次数', '转化'],
  conversionValue: ['conversion value', 'conv. value', '转化价值', '转化次数价值'],
  day: ['day', 'date', '日期', '天'],
  start: ['start date', 'report start date', '开始日期', '报告开始日期'],
  end: ['end date', 'report end date', '结束日期', '报告结束日期']
}
const normalize = (s: string): string => s.replace(/^\ufeff/, '').trim().toLowerCase().replace(/\s+/g, ' ')
const iso = (s: string): string | null => {
  const text = s.trim()
  let m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(text)
  if (!m) {
    const en = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text)
    const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
    if (!en || !months[en[1].slice(0, 3).toLowerCase()]) return null
    m = [text, en[3], String(months[en[1].slice(0, 3).toLowerCase()]), en[2]] as unknown as RegExpExecArray
  }
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const d = new Date(Date.UTC(y, month - 1, day))
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null
}
const number = (raw: string): number | null => {
  const value = raw.trim().replace(/^(?:US\$|USD\s*)/i, '')
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(value)) return null
  const n = Number(value.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
function titleWindow(rows: string[][]): { start: string; end: string } | null {
  for (const row of rows) {
    const text = row.join(',').trim()
    const single = iso(text)
    if (single) return { start: single, end: single }
    const match = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*(?:-|–|—|至|到)\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})$/.exec(text)
    if (match) { const start = iso(match[1]), end = iso(match[2]); if (start && end && start <= end) return { start, end } }
  }
  return null
}
/** Parse the date selector label only; ambiguous or relative dates are refused. */
export function parseGoogleVisibleDateRange(label: string): { start: string; end: string } | null {
  const cleaned = label.trim().replace(/\s+(?:不适用|not applicable)$/i, '').trim()
  const single = iso(cleaned)
  if (single) return { start: single, end: single }
  const range = titleWindow([[cleaned]])
  return range
}
export function parseGoogleReportCsv(csv: string, context?: GoogleReportContext): GoogleReportParseOutcome {
  const errors: string[] = []
  const fail = (reason: string): GoogleReportParseOutcome => ({ verification: { verified: false, errors: [reason], warnings: [] }, summary: null })
  const parsed = Papa.parse<string[]>(csv.replace(/^\ufeff/, ''), { skipEmptyLines: true, delimiter: ',' })
  if (parsed.errors.length) return fail('invalid-csv')
  const rows = parsed.data
  let headerIndex = -1
  let columns: Record<string, number> = {}
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const found: Record<string, number> = {}
    rows[i].forEach((cell, index) => { for (const [key, names] of Object.entries(aliases)) if (names.includes(normalize(cell))) found[key] = index })
    if (found.campaign !== undefined && found.spend !== undefined) { headerIndex = i; columns = found; break }
  }
  if (headerIndex < 0) return fail('missing-columns')
  if (context && (!/^\d{10}$/.test(context.accountId) || !/^[A-Z]{3}$/.test(context.currency) || !/^GMT[+-]\d{1,2}(?::\d{2})?$/.test(context.timezone) || iso(context.windowStart) !== context.windowStart || iso(context.windowEnd) !== context.windowEnd || context.windowStart > context.windowEnd)) return fail('invalid-context')
  if ((!context && columns.accountId === undefined) || (!context && columns.currency === undefined)) return fail('missing-account-or-currency')
  const preamble = titleWindow(rows.slice(0, headerIndex))
  if (context && preamble && (context.windowStart !== preamble.start || context.windowEnd !== preamble.end)) return fail('conflicting-date-range')
  const accounts = new Map<string, GoogleReportAccount>()
  const seen = new Set<string>()
  const currentViewTotals: string[][] = []
  let start: string | null = preamble?.start ?? context?.windowStart ?? null, end: string | null = preamble?.end ?? context?.windowEnd ?? null
  let detailCount = 0
  for (const row of rows.slice(headerIndex + 1)) {
    const totalLabel = (value: string): boolean => /^(total\s*:|总计[：:]|合计[：:]|总计$|合计$)/i.test(value.trim())
    const label = [row[columns.campaign] ?? '', row[0] ?? ''].find(totalLabel)
    if (label) {
      if (/^(?:total\s*:\s*campaigns\s*|总计[：:]\s*当前视图.*)$/i.test(label.trim())) currentViewTotals.push(row)
      continue
    }
    if (row.length !== rows[headerIndex].length) return fail('invalid-row')
    const get = (key: string): string => columns[key] === undefined ? '' : (row[columns[key]] ?? '').trim()
    const campaign = get('campaign')
    if (!campaign) return fail('missing-campaign')
    const accountId = get('accountId').replace(/-/g, '') || context?.accountId || ''
    const currency = get('currency').toUpperCase() || context?.currency || ''
    if (!/^\d{10}$/.test(accountId) || !/^[A-Z]{3}$/.test(currency)) return fail('invalid-account-or-currency')
    if (context && (accountId !== context.accountId || currency !== context.currency)) return fail('conflicting-account-or-currency')
    const day = get('day') ? iso(get('day')) : null
    const rowStart = get('start') ? iso(get('start')) : null
    const rowEnd = get('end') ? iso(get('end')) : null
    if ((get('day') && !day) || (get('start') && !rowStart) || (get('end') && !rowEnd)) return fail('invalid-date')
    if (rowStart || rowEnd) {
      if (!rowStart || !rowEnd || rowStart > rowEnd || (start && start !== rowStart) || (end && end !== rowEnd)) return fail('conflicting-date-range')
      start = rowStart; end = rowEnd
    }
    if (day && start && end && (day < start || day > end)) return fail('date-outside-window')
    // A list of days only shows days with data; it does not establish the requested report window.
    const key = `${accountId}\0${campaign}\0${day ?? ''}`
    if (seen.has(key)) return fail('duplicate-campaign-row')
    seen.add(key)
    const spend = number(get('spend'))
    if (spend === null) return fail('invalid-spend')
    const metric = (name: string): number | null => columns[name] === undefined ? null : number(get(name))
    const impressions = metric('impressions'), clicks = metric('clicks'), conversions = metric('conversions'), conversionValue = metric('conversionValue')
    for (const [name, n] of Object.entries({ impressions, clicks, conversions, conversionValue })) if (columns[name] !== undefined && n === null) errors.push(`invalid-${name}`)
    if (errors.length) return fail(errors[0])
    let account = accounts.get(accountId)
    const accountName = get('accountName') || context?.accountName || null
    if (context?.accountName && get('accountName') && get('accountName') !== context.accountName) return fail('conflicting-account')
    if (!account) { account = { accountId, accountName, currency, spend: 0, impressions: columns.impressions === undefined ? null : 0, clicks: columns.clicks === undefined ? null : 0, conversions: columns.conversions === undefined ? null : 0, conversionValue: columns.conversionValue === undefined ? null : 0, campaigns: [] }; accounts.set(accountId, account) }
    if (account.currency !== currency || (account.accountName && accountName && account.accountName !== accountName)) return fail('conflicting-account')
    account.spend += spend
    if (account.impressions !== null && impressions !== null) account.impressions += impressions
    if (account.clicks !== null && clicks !== null) account.clicks += clicks
    if (account.conversions !== null && conversions !== null) account.conversions += conversions
    if (account.conversionValue !== null && conversionValue !== null) account.conversionValue += conversionValue
    const extraFields: Record<string, string[]> = Object.create(null)
    const knownColumns = new Set(Object.values(columns))
    row.forEach((value, index) => {
      const name = rows[headerIndex][index]?.trim()
      const entry = value.trim()
      if (!knownColumns.has(index) && name && name.length <= 120 && entry && entry.length <= 200 && Object.keys(extraFields).length < 100) extraFields[name] = [entry]
    })
    const existing = account.campaigns.find((c) => c.name === campaign)
    if (existing) { for (const [key, values] of Object.entries(extraFields)) { const current = (existing.customFields ??= Object.create(null))[key] ??= []; for (const value of values) if (!current.includes(value) && current.length < 50) current.push(value) }; existing.spend += spend; if (existing.impressions !== null && impressions !== null) existing.impressions += impressions; if (existing.clicks !== null && clicks !== null) existing.clicks += clicks; if (existing.conversions !== null && conversions !== null) existing.conversions += conversions }
    else account.campaigns.push({ name: campaign, spend, impressions, clicks, conversions, customFields: extraFields })
    detailCount++
  }
  if (!start || !end) return fail('missing-date-range')
  if (!detailCount) return fail('no-detail-rows')
  if (accounts.size === 1) {
    const account = [...accounts.values()][0]
    for (const row of currentViewTotals) {
      const totalId = columns.accountId === undefined ? '' : (row[columns.accountId] ?? '').trim().replace(/-/g, '')
      const totalCurrency = columns.currency === undefined ? '' : (row[columns.currency] ?? '').trim().toUpperCase()
      if ((totalId && totalId !== account.accountId) || (totalCurrency && totalCurrency !== account.currency)) return fail('conflicting-total-scope')
      for (const key of ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'] as const) {
        if (columns[key] === undefined) continue
        const raw = (row[columns[key]] ?? '').trim()
        if (!raw && key !== 'spend') continue
        const expected = number(raw), actual = account[key]
        if (expected === null || actual === null) return fail('invalid-view-total')
        const tolerance = key === 'spend' || key === 'conversionValue' ? 0.0100001 : 0.000001
        if (Math.abs(expected - actual) > tolerance) return fail('view-total-mismatch')
      }
    }
  }
  return { verification: { verified: true, errors: [], warnings: ['report-scope-only'] }, summary: { windowStart: start, windowEnd: end, accounts: [...accounts.values()], ...(context ? { timezone: context.timezone } : {}) } }
}

export interface GoogleReportAutoFetchResult {
  ok: boolean
  filePath?: string
  context?: GoogleReportContext
  error?: 'invalid-url' | 'context-unavailable' | 'panel-not-open' | 'navigation-failed' | 'login-required' | 'export-button-not-found' | 'csv-option-not-found' | 'download-timeout' | 'download-failed' | 'fetch-failed'
  detail?: string
}

export interface GoogleReportReadingResult extends GoogleReportImportResult {
  fetchError?: GoogleReportAutoFetchResult['error']
  detail?: string
}

/** Never allow arbitrary navigation or credential-bearing URLs from the renderer. */
export function validGoogleReportUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 12000) return false
  try {
    const url = new URL(raw)
    if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|credential|authorization|api[_-]?key|session[_-]?id)/i.test(key))) return false
    if (/(?:token|secret|password|credential|authorization|api[_-]?key)=/i.test(url.hash)) return false
    return url.protocol === 'https:' && url.hostname === 'ads.google.com' && !url.username && !url.password && !url.port && url.pathname.startsWith('/aw/')
  } catch { return false }
}
