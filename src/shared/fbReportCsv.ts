// Facebook Ads Reporting CSV import — shared, pure, no Electron imports.
//
// Contract (v1):
// - Input is a CSV exported from Facebook 广告报告 (UTF-8, BOM tolerated),
//   RFC4180 quoting. Columns map BY NAME through zh/en aliases, order-free.
// - Unknown numeric columns join the metric set (kind guessed from the
//   header); unknown text columns join the dimension set. 货币/归因/报告日期
//   are metadata, never dimensions.
// - Rows classify structurally: every dimension empty → Facebook totals row;
//   some empty → subtotal row (excluded from sums); none empty → detail row.
// - verified hard gates: account column, spend column, a FB totals row and a
//   date context (report window columns or a day column) must exist, and
//   money/conversion metrics (spend, installs, purchases, clicks) must sum
//   exactly to the FB totals row. Volume metrics (impressions, reach…) may
//   differ by FB's own export noise — the totals row stays the displayed
//   truth and the difference is recorded as a warning, never as data.

export const FB_REPORT_CONTRACT_VERSION = 1

export type FbReportMetricKind = 'money' | 'count' | 'rate'
export type FbReportLanguage = 'zh' | 'en' | 'unknown'

export interface FbReportMetricColumn {
  header: string
  semantic: string | null
  kind: FbReportMetricKind
}

export interface FbReportMapping {
  language: FbReportLanguage
  dimensions: string[]
  metrics: FbReportMetricColumn[]
  /** Canonical semantic per known column header (display/debug aid). */
  semanticByHeader: Record<string, string>
  meta: string[]
}

export interface FbReportIssue {
  code: string
  column?: string
  expected?: number | null
  actual?: number | null
}

export interface FbReportVerification {
  verified: boolean
  fatal: FbReportIssue[]
  warnings: FbReportIssue[]
}

export interface FbReportAccountRow {
  account: string
  spend: number | null
  impressions: number | null
  clicks: number | null
  installs: number | null
  purchases: number | null
  cpm: number | null
  cpi: number | null
  ctr: number | null
}

export interface FbReportSummary {
  windowStart: string | null
  windowEnd: string | null
  days: string[]
  currency: string | null
  attribution: string | null
  accounts: FbReportAccountRow[]
  /** Facebook's own totals-row values by canonical semantic. */
  totals: Record<string, number | null>
}

export interface FbReportParseOutcome {
  ok: boolean
  verification: FbReportVerification
  mapping: FbReportMapping
  summary: FbReportSummary | null
  detailRows: number
  subtotalRows: number
}

/** What Main persists per widget after a verified import (no raw rows). */
export interface FbReportStoredReading {
  widgetId: string
  importedAt: number
  fileName: string
  contractVersion: number
  summary: FbReportSummary
  warnings: FbReportIssue[]
}

export interface FbReportImportResult {
  ok: boolean
  canceled?: boolean
  error?: 'file-read-failed' | 'file-too-large' | 'file-empty' | 'invalid-widget'
  outcome?: FbReportParseOutcome
  reading?: FbReportStoredReading
}

/** Why an automated export fetch failed (Main classifies, renderer words it). */
export type FbReportFetchErrorCode =
  | 'panel-not-open'
  | 'navigation-failed'
  | 'login-required'
  | 'report-not-found'
  | 'export-button-not-found'
  | 'csv-option-not-found'
  | 'download-timeout'
  | 'download-failed'
  | 'fetch-failed'

export interface FbReportAutoFetchResult extends FbReportImportResult {
  fetchError?: FbReportFetchErrorCode
  /** Bounded page/flow evidence for the collapsed technical details. */
  detail?: string
}

const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

const DIMENSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  account: ['账户名称', 'account name'],
  day: ['单日', 'day'],
  ad: ['广告名称', 'ad name'],
  campaign: ['广告系列名称', 'campaign name'],
  adset: ['广告组名称', 'ad set name'],
  country: ['国家/地区', 'country'],
  placement: ['版位', 'placement'],
  platform: ['平台', 'platform'],
  age: ['年龄', 'age'],
  gender: ['性别', 'gender']
}

const METRIC_ALIASES: Readonly<Record<string, readonly string[]>> = {
  spend: ['已花费金额 (usd)', '已花费金额', 'amount spent (usd)', 'amount spent'],
  impressions: ['展示次数', 'impressions'],
  clicks: ['点击次数（全部）', '点击次数(全部)', 'clicks (all)', 'link clicks'],
  installs: ['应用安装量', 'app installs'],
  purchases: ['应用内购物', 'in-app purchases', 'app purchases'],
  reach: ['覆盖人数', 'reach'],
  frequency: ['频次', 'frequency'],
  cpm: ['cpm（千次展示费用）', 'cpm (cost per 1,000 impressions)', 'cpm'],
  ctr: ['点击率（全部）', '点击率(全部)', 'ctr (all)', 'ctr'],
  cpi: ['单次应用安装费用', 'cost per app install']
}

const META_ALIASES: Readonly<Record<string, readonly string[]>> = {
  currency: ['货币', 'currency'],
  attribution: ['归因设置', 'attribution setting'],
  windowStart: ['报告开始日期', 'reporting start date', 'reporting starts'],
  windowEnd: ['报告结束日期', 'reporting end date', 'reporting ends']
}

const METRIC_KINDS: Readonly<Record<string, FbReportMetricKind>> = {
  spend: 'money',
  impressions: 'count',
  clicks: 'count',
  installs: 'count',
  purchases: 'count',
  reach: 'count',
  frequency: 'rate',
  cpm: 'rate',
  ctr: 'rate',
  cpi: 'rate'
}

/** Money and conversion metrics reconcile exactly with FB's totals row. */
const HARD_SUM_SEMANTICS: readonly string[] = ['spend', 'installs', 'purchases', 'clicks']
/** Volume metrics may differ by export noise; warn only, display FB totals.
 * Reach (deduplicated) and rates are never summed — summing them is noise. */
const SOFT_SUM_SEMANTICS: readonly string[] = ['impressions']

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

export function parseFbReportNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/[\s$¥]/g, '')
    .replace(/us\$/i, '')
    .replace(/,/g, '')
    .replace(/%$/, '')
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Minimal RFC4180 parser: quoted fields, escaped quotes, CR/LF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const emptyOutcome = (fatal: FbReportIssue[]): FbReportParseOutcome => ({
  ok: false,
  verification: { verified: false, fatal, warnings: [] },
  mapping: { language: 'unknown', dimensions: [], metrics: [], semanticByHeader: {}, meta: [] },
  summary: null,
  detailRows: 0,
  subtotalRows: 0
})

export function parseFbReportCsv(text: string): FbReportParseOutcome {
  const fatal: FbReportIssue[] = []
  const warnings: FbReportIssue[] = []
  const rows = parseCsv(text.replace(/^\uFEFF/, ''))
  const header = rows[0] ?? []
  const records = rows.slice(1).filter((row) => row.some((cell) => (cell ?? '').trim() !== ''))
  if (header.length === 0 || records.length === 0) return emptyOutcome([{ code: 'parse-empty' }])

  const headerNorm = header.map((h) => norm(h))
  const claimed = new Set<number>()
  const semanticByHeader: Record<string, string> = {}
  const indexBySemantic: Record<string, number> = {}
  const metaHeaders: string[] = []

  const claimAlias = (semantic: string, aliases: readonly string[]): boolean => {
    for (let i = 0; i < headerNorm.length; i++) {
      if (claimed.has(i)) continue
      if (aliases.some((alias) => norm(alias) === headerNorm[i])) {
        claimed.add(i)
        indexBySemantic[semantic] = i
        if (!semanticByHeader[header[i]]) semanticByHeader[header[i]] = semantic
        return true
      }
    }
    return false
  }

  for (const [semantic, aliases] of Object.entries(DIMENSION_ALIASES)) claimAlias(semantic, aliases)
  for (const [semantic, aliases] of Object.entries(METRIC_ALIASES)) claimAlias(semantic, aliases)
  // Spend prefix fallback: "已花费金额 (EUR)" style headers still map.
  if (indexBySemantic.spend === undefined) {
    for (let i = 0; i < headerNorm.length; i++) {
      if (claimed.has(i)) continue
      if (headerNorm[i].startsWith('已花费金额') || headerNorm[i].startsWith('amount spent')) {
        claimed.add(i)
        indexBySemantic.spend = i
        semanticByHeader[header[i]] = 'spend'
        break
      }
    }
  }
  for (const [semantic, aliases] of Object.entries(META_ALIASES)) {
    for (let i = 0; i < headerNorm.length; i++) {
      if (claimed.has(i)) continue
      if (aliases.some((alias) => norm(alias) === headerNorm[i])) {
        claimed.add(i)
        indexBySemantic[semantic] = i
        metaHeaders.push(header[i])
        if (!semanticByHeader[header[i]]) semanticByHeader[header[i]] = semantic
        break
      }
    }
  }

  if (indexBySemantic.account === undefined) return emptyOutcome([{ code: 'missing-account-column' }])
  if (indexBySemantic.spend === undefined) return emptyOutcome([{ code: 'missing-spend-column' }])

  // Language: whichever alias set the account column came from.
  const accountHeader = headerNorm[indexBySemantic.account]
  const language: FbReportLanguage = /[一-鿿]/.test(accountHeader) ? 'zh' : 'en'

  // Candidate detail rows (known dimensions filled) drive unknown-column typing.
  const knownDimIdx = Object.keys(DIMENSION_ALIASES)
    .map((semantic) => indexBySemantic[semantic])
    .filter((idx): idx is number => idx !== undefined)
  const candidates = records.filter((row) => knownDimIdx.every((idx) => (row[idx] ?? '').trim() !== ''))
  const sample = (candidates.length >= 3 ? candidates : records).slice(0, 200)

  const dimensionIdx: number[] = [...knownDimIdx]
  const metricCols: FbReportMetricColumn[] = []
  for (const [semantic, kind] of Object.entries(METRIC_KINDS)) {
    const idx = indexBySemantic[semantic]
    if (idx !== undefined) metricCols.push({ header: header[idx], semantic, kind })
  }
  for (let i = 0; i < header.length; i++) {
    if (claimed.has(i)) continue
    const nonEmpty = sample.map((row) => (row[i] ?? '').trim()).filter(Boolean)
    if (nonEmpty.length === 0) continue
    const numeric = nonEmpty.filter((value) => parseFbReportNumber(value) !== null)
    if (nonEmpty.length >= 3 && numeric.length / nonEmpty.length >= 0.9) {
      const h = headerNorm[i]
      const kind: FbReportMetricKind = /(花费|spend|cost|费用)/.test(h)
        ? 'money'
        : /(率|rate|cpm|cpi|cpa|roas)/.test(h)
          ? 'rate'
          : 'count'
      metricCols.push({ header: header[i], semantic: null, kind })
    } else {
      dimensionIdx.push(i)
    }
  }
  dimensionIdx.sort((a, b) => a - b)

  // Structural row classification.
  let totalsRow: string[] | null = null
  let totalsCount = 0
  let subtotalRows = 0
  const detail: string[][] = []
  for (const row of records) {
    const filled = dimensionIdx.map((idx) => (row[idx] ?? '').trim() !== '')
    if (filled.every(Boolean)) {
      detail.push(row)
    } else if (filled.some(Boolean)) {
      subtotalRows++
    } else {
      totalsCount++
      if (totalsRow === null) totalsRow = row
    }
  }
  if (totalsCount === 0) fatal.push({ code: 'missing-totals-row' })
  if (totalsCount > 1) fatal.push({ code: 'ambiguous-totals' })

  const idxOf = (semantic: string): number | undefined => indexBySemantic[semantic]
  const windowStartIdx = idxOf('windowStart')
  const windowEndIdx = idxOf('windowEnd')
  let windowStart: string | null = null
  let windowEnd: string | null = null
  // The TOTALS row carries the export window. Multi-day exports put each
  // detail row's OWN day in its window columns — that is legitimate, so the
  // detail windows only need to fall inside the totals window. Single-day
  // exports have one window everywhere and pass the same check.
  const within = (value: string, start: string | null, end: string | null): boolean =>
    (!start || value >= start) && (!end || value <= end)
  if (windowStartIdx !== undefined || windowEndIdx !== undefined) {
    if (totalsRow !== null) {
      windowStart = windowStartIdx !== undefined ? (totalsRow[windowStartIdx] ?? '').trim() || null : null
      windowEnd = windowEndIdx !== undefined ? (totalsRow[windowEndIdx] ?? '').trim() || null : null
      for (const row of detail) {
        const s = windowStartIdx !== undefined ? (row[windowStartIdx] ?? '').trim() : ''
        const e = windowEndIdx !== undefined ? (row[windowEndIdx] ?? '').trim() : ''
        if ((s && !within(s, windowStart, windowEnd)) || (e && !within(e, windowStart, windowEnd))) {
          fatal.push({ code: 'window-inconsistent' })
          break
        }
      }
    } else {
      const starts = new Set<string>()
      const ends = new Set<string>()
      for (const row of records) {
        const s = windowStartIdx !== undefined ? (row[windowStartIdx] ?? '').trim() : ''
        const e = windowEndIdx !== undefined ? (row[windowEndIdx] ?? '').trim() : ''
        if (s) starts.add(s)
        if (e) ends.add(e)
      }
      if (starts.size > 1 || ends.size > 1) fatal.push({ code: 'window-inconsistent' })
      windowStart = [...starts][0] ?? null
      windowEnd = [...ends][0] ?? null
    }
  }
  if (windowStartIdx === undefined && windowEndIdx === undefined && idxOf('day') === undefined) {
    fatal.push({ code: 'missing-date-columns' })
  }

  const cell = (row: string[], idx: number | undefined): string => (idx === undefined ? '' : (row[idx] ?? ''))
  const sumOf = (rowsList: string[][], idx: number | undefined): number | null =>
    idx === undefined ? null : round6(rowsList.reduce((acc, row) => acc + (parseFbReportNumber(row[idx] ?? '') ?? 0), 0))

  // Hard/soft reconciliation against Facebook's own totals row.
  if (totalsRow !== null) {
    for (const semantic of HARD_SUM_SEMANTICS) {
      const idx = idxOf(semantic)
      if (idx === undefined) continue
      const expected = parseFbReportNumber(cell(totalsRow, idx))
      if (expected === null) {
        fatal.push({ code: 'totals-value-missing', column: header[idx] })
        continue
      }
      const actual = sumOf(detail, idx) ?? 0
      const tolerance = METRIC_KINDS[semantic] === 'money' ? 0.01 : 0.000001
      if (Math.abs(actual - expected) > tolerance) {
        fatal.push({ code: 'sum-mismatch', column: header[idx], expected, actual })
      }
    }
    for (const semantic of SOFT_SUM_SEMANTICS) {
      const idx = idxOf(semantic)
      if (idx === undefined) continue
      const expected = parseFbReportNumber(cell(totalsRow, idx))
      const actual = sumOf(detail, idx)
      if (expected !== null && actual !== null && Math.abs(actual - expected) > 0.01) {
        warnings.push({ code: 'sum-diff', column: header[idx], expected, actual })
      }
    }
  }

  // Metadata + per-account aggregation over detail rows.
  const currencyIdx = indexBySemantic.currency ?? -1
  const attributionIdx = indexBySemantic.attribution ?? -1
  const firstNonEmpty = (idx: number): string | null => {
    if (idx < 0) return null
    for (const row of records) {
      const value = (row[idx] ?? '').trim()
      if (value) return value
    }
    return null
  }
  const spendHeader = idxOf('spend') !== undefined ? header[idxOf('spend') as number] : ''
  const currency = firstNonEmpty(currencyIdx) ?? (/\((usd)\)/i.test(norm(spendHeader)) ? 'USD' : null)
  const attribution = firstNonEmpty(attributionIdx)

  const accountIdx = idxOf('account') as number
  const spendIdx = idxOf('spend')
  const impressionsIdx = idxOf('impressions')
  const clicksIdx = idxOf('clicks')
  const installsIdx = idxOf('installs')
  const purchasesIdx = idxOf('purchases')
  const dayIdx = idxOf('day')

  const groups = new Map<string, string[][]>()
  const daySet = new Set<string>()
  for (const row of detail) {
    const account = (row[accountIdx] ?? '').trim()
    if (!account) continue
    groups.set(account, [...(groups.get(account) ?? []), row])
    if (dayIdx !== undefined) {
      const day = (row[dayIdx] ?? '').trim()
      if (day) daySet.add(day)
    }
  }

  const accounts: FbReportAccountRow[] = [...groups.entries()]
    .map(([account, rowsList]) => {
      const spend = sumOf(rowsList, spendIdx)
      const impressions = sumOf(rowsList, impressionsIdx)
      const clicks = sumOf(rowsList, clicksIdx)
      const installs = sumOf(rowsList, installsIdx)
      const purchases = sumOf(rowsList, purchasesIdx)
      return {
        account,
        spend,
        impressions,
        clicks,
        installs,
        purchases,
        cpm: spend !== null && impressions !== null && impressions > 0 ? round6((spend / impressions) * 1000) : null,
        cpi: spend !== null && installs !== null && installs > 0 ? round6(spend / installs) : null,
        ctr: clicks !== null && impressions !== null && impressions > 0 ? round6((clicks / impressions) * 100) : null
      }
    })
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))

  const totals: Record<string, number | null> = {}
  if (totalsRow !== null) {
    for (const semantic of ['spend', 'impressions', 'clicks', 'installs', 'purchases']) {
      const idx = idxOf(semantic)
      totals[semantic] = idx === undefined ? null : parseFbReportNumber(cell(totalsRow, idx))
    }
  }

  const mapping: FbReportMapping = {
    language,
    dimensions: dimensionIdx.map((idx) => header[idx]),
    metrics: metricCols,
    semanticByHeader,
    meta: metaHeaders
  }

  return {
    ok: true,
    verification: { verified: fatal.length === 0, fatal, warnings },
    mapping,
    summary: {
      windowStart,
      windowEnd,
      days: [...daySet].sort(),
      currency,
      attribution,
      accounts,
      totals
    },
    detailRows: detail.length,
    subtotalRows
  }
}
