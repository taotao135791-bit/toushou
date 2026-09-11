/**
 * Ads Manager campaign-table parser.
 *
 * Input is the browser-panel snapshot format (the innerText of the page
 * main region, exactly what SNAPSHOT_SCRIPT in src/main/browserUse.ts
 * produces and what fb-snapshots.json archives). The parser is deliberately
 * strict: it recognizes ONE well-known shape — the campaigns table with the
 * "leo 的列" column preset — and returns null for anything else instead of
 * guessing. FB layout changes should surface as parse failures that we then
 * fix against the archived snapshots, never as silently wrong numbers.
 *
 * Shape (verified against a real archived-format capture, 2026-09-11):
 *   账户行:   "COOPLAY-ADT-IOS-03 (2131017261144314)"
 *   日期:     "过去 30 天：2026年8月12日 – 2026年9月10日" (also 今天/昨天)
 *   列头区:   从 "关/开" 起、到 "定制列..." 止
 *   数据行:   camp 名一行 + 固定 9 个值行（金额/—/百分比/数字/成效类型）
 *   汇总区:   "N个广告系列的成效" 之后成对的 值+标签
 */

export interface FbAdsSnapshotInput {
  url?: string
  title?: string
  text: string
}

export interface FbAdsCampaignRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  results: number | null
  resultType: string | null
  clicks: number | null
  ctr: number | null
  cpc: number | null
  installs: number | null
  /** Original value lines, kept for audit/verification. */
  raw: string[]
}

export interface FbAdsCampaignReading {
  kind: 'ads-manager-campaigns'
  accountId: string | null
  accountName: string | null
  dateRangeLabel: string | null
  columns: string[]
  rows: FbAdsCampaignRow[]
  /** Summary-block total spend; should equal the sum of row spends. */
  totalSpend: number | null
}

/** The fixed value-line count of the supported column preset, after the name. */
const VALUES_PER_ROW = 9

const SUMMARY_MARKER = /^(\d+)个(广告系列|广告组|广告)的成效$/
const ACCOUNT_LINE = /^(.{1,120}?) \((\d{8,})\)$/
const DATE_LINE = /^(今天|昨天|过去 \d+ 天|过去 \d+ 周|本月|上年)：(.+)$/
/** A metric value line: money, em/en dash, percentage, or plain number. */
const VALUE_LINE = /^(—|–|-|\$[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?%|[\d,]+(?:\.\d+)?)$/
/** The result-type label under the 成效 column (e.g. 应用内购买). */
const RESULT_TYPE_LABEL = /^[\u4e00-\u9fff][\u4e00-\u9fff（）()/A-Za-z0-9 ]{0,19}$/

/** "$3,146.47" → 3146.47; "2.61%" → 2.61; "1,110" → 1110; else null. */
export function parseFbMetricNumber(line: string): number | null {
  const t = line.trim()
  if (t === '—' || t === '-' || t === '') return null
  const m = t.match(/^\$?([\d,]+(?:\.\d+)?)%?$/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Exported for tests: does this line look like a metric value? */
export function isValueLine(line: string): boolean {
  return VALUE_LINE.test(line.trim())
}

function isValueOrResultLabel(line: string): boolean {
  return isValueLine(line) || RESULT_TYPE_LABEL.test(line.trim())
}

/**
 * Parse one snapshot. Returns null unless the text matches the supported
 * campaigns-table shape exactly — callers treat null as "cannot read this
 * page" rather than falling back to guesswork.
 */
export function parseFbAdsCampaignsSnapshot(input: FbAdsSnapshotInput): FbAdsCampaignReading | null {
  if (!input || typeof input.text !== 'string' || input.text.length === 0) return null
  const lines = input.text.split('\n').map((l) => l.replace(/\u200b/g, '').trim()).filter((l) => l !== '')
  if (lines.length < 10) return null

  // Account: prefer the act= URL param, fall back to the "name (id)" line.
  let accountId: string | null = null
  if (typeof input.url === 'string') {
    const m = input.url.match(/[?&]act=(\d{6,})/)
    if (m) accountId = m[1]
  }
  let accountName: string | null = null
  for (const line of lines) {
    const m = line.match(ACCOUNT_LINE)
    if (m) {
      accountName = m[1].trim()
      if (!accountId) accountId = m[2]
      break
    }
  }
  if (!accountId) return null

  // Date label: the first 今天/昨天/过去 N 天/… line.
  let dateRangeLabel: string | null = null
  for (const line of lines) {
    const m = line.match(DATE_LINE)
    if (m) {
      dateRangeLabel = line
      break
    }
  }

  // Column headers: between the 关/开 marker and 定制列...
  const headerStart = lines.indexOf('关/开')
  const headerEnd = lines.indexOf('定制列...')
  if (headerStart < 0 || headerEnd <= headerStart + 1) return null
  const columns = lines.slice(headerStart + 1, headerEnd)
  if (columns.length < 4) return null

  // Rows: after 定制列..., until the summary marker. Each row = name + 9 values.
  const rows: FbAdsCampaignRow[] = []
  let i = headerEnd + 1
  while (i < lines.length) {
    if (SUMMARY_MARKER.test(lines[i])) break
    const name = lines[i]
    if (!name || isValueLine(name)) return null
    const values = lines.slice(i + 1, i + 1 + VALUES_PER_ROW)
    if (values.length < VALUES_PER_ROW) return null
    // Positions 0-3 and 5-8 must be metric values; position 4 carries the
    // result count's type label (应用内购买) when the result cell renders it.
    const metricPositions = [...values.slice(0, 4), ...values.slice(5)]
    if (!metricPositions.every(isValueLine) || !isValueOrResultLabel(values[4])) return null
    rows.push({
      name,
      spend: parseFbMetricNumber(values[0]),
      costPerResult: parseFbMetricNumber(values[1]),
      cpm: parseFbMetricNumber(values[2]),
      results: parseFbMetricNumber(values[3]),
      resultType: values[4] === '—' ? null : values[4],
      clicks: parseFbMetricNumber(values[5]),
      ctr: parseFbMetricNumber(values[6]),
      cpc: parseFbMetricNumber(values[7]),
      installs: parseFbMetricNumber(values[8]),
      raw: values
    })
    i += 1 + VALUES_PER_ROW
  }
  if (rows.length === 0) return null

  // Summary: value+label pairs after the marker; grab 总花费 for cross-check.
  let totalSpend: number | null = null
  if (i < lines.length && SUMMARY_MARKER.test(lines[i])) {
    for (let j = i + 1; j < lines.length - 1; j++) {
      if (isValueLine(lines[j]) && lines[j + 1] === '总花费') {
        totalSpend = parseFbMetricNumber(lines[j])
        break
      }
    }
  }

  return { kind: 'ads-manager-campaigns', accountId, accountName, dateRangeLabel, columns, rows, totalSpend }
}

/**
 * Cross-check the parse: the summary total (when present) must equal the sum
 * of row spends to the cent. Used by callers to gate the numbers they show.
 */
export function fbAdsReadingTotalsMatch(reading: FbAdsCampaignReading): boolean | null {
  if (reading.totalSpend === null) return null
  const sum = reading.rows.reduce((acc, r) => acc + (r.spend ?? 0), 0)
  return Math.abs(sum - reading.totalSpend) < 0.005
}
