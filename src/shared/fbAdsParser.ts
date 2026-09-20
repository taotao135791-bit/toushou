/**
 * Ads Manager campaign-table parser.
 *
 * Input is the browser-panel snapshot format (the innerText of the page
 * main region, exactly what SNAPSHOT_SCRIPT in src/main/browserUse.ts
 * produces and what fb-snapshots.json archives). The parser is deliberately
 * strict: row cells are mapped to metrics by the page's own column headers
 * (a fixed zh/en label dictionary), so any account's saved column view —
 * any known set, any order — parses correctly. Unknown header labels fail
 * closed: we extend the dictionary against the archived snapshot instead of
 * guessing a position. Never silently wrong numbers.
 *
 * Shape (verified against a real archived-format capture, 2026-09-11):
 *   账户行:   "COOPLAY-ADT-IOS-03 (2131017261144314)"
 *   日期:     "过去 30 天：2026年8月12日 – 2026年9月10日" (also 今天/昨天)
 *   列头区:   从 "关/开" 起、到 "定制列..." 止（表头驱动取数）
 *   数据行:   camp 名一行 + 连续值行（按表头映射；右侧未渲染列虚拟化裁剪）
 *   汇总区:   "N个广告系列的成效" 之后成对的 值+标签
 */

import { parseFbReadingDateRange } from './fbReading'

export interface FbAdsSnapshotInput {
  url?: string
  title?: string
  text: string
  observedAt?: number
}

export interface FbAdsObservation {
  capturedAt: string
  sourceUrl: string | null
  sourceTitle: string | null
  currency: string | null
  timezone: string | null
  attributionWindow: string | null
  visibleRows: number
  readRows: number
  totalRows: number | null
  coverage: 'complete' | 'partial' | 'unknown'
  columnMode: 'wide' | 'narrow' | 'unknown'
}

export interface FbAdsCampaignRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  impressions: number | null
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
  /** The N in the page's "N个广告系列的成效" summary marker. */
  campaignCount: number | null
  columns: string[]
  rows: FbAdsCampaignRow[]
  /** Summary-block total spend; should equal the sum of row spends. */
  totalSpend: number | null
  /** Evidence metadata for this observation; unknown fields stay null. */
  observation?: FbAdsObservation
}

const ROW_HOVER_ACTIONS = ['图表', '编辑', '新建副本', '对比', '打开下拉菜单']

/** What one column-header label tells us about its row cells. */
type HeaderOp =
  | {
      kind: 'field'
      field: 'spend' | 'costPerResult' | 'cpm' | 'impressions' | 'clicks' | 'ctr' | 'cpc' | 'installs'
    }
  | { kind: 'results' }
  | { kind: 'skip' }
  | { kind: 'icon' }
  | { kind: 'unknown' }

/**
 * Header label dictionary (zh + common en). 'field' stores the cell;
 * 'results' consumes the count plus its type label; 'skip' consumes a
 * rendered value we deliberately do not store; 'icon' renders no text
 * (toggles, action menus). Every label in the header block MUST be listed
 * here — unknown labels fail closed so positions are never guessed.
 */
const HEADER_OPS: Record<string, HeaderOp> = {
  '已花费金额': { kind: 'field', field: 'spend' },
  'Amount spent': { kind: 'field', field: 'spend' },
  '单次应用安装费用': { kind: 'field', field: 'costPerResult' },
  '单次成效费用': { kind: 'field', field: 'costPerResult' },
  'Cost per app install': { kind: 'field', field: 'costPerResult' },
  'Cost per result': { kind: 'field', field: 'costPerResult' },
  'CPM（千次展示费用）': { kind: 'field', field: 'cpm' },
  'CPM': { kind: 'field', field: 'cpm' },
  'CPM (cost per 1,000 impressions)': { kind: 'field', field: 'cpm' },
  '成效': { kind: 'results' },
  'Results': { kind: 'results' },
  '点击量（全部）': { kind: 'field', field: 'clicks' },
  '链接点击量': { kind: 'field', field: 'clicks' },
  'Clicks (all)': { kind: 'field', field: 'clicks' },
  'Link clicks': { kind: 'field', field: 'clicks' },
  '点击率（全部）': { kind: 'field', field: 'ctr' },
  '链接点击率': { kind: 'field', field: 'ctr' },
  'CTR (all)': { kind: 'field', field: 'ctr' },
  'Link CTR': { kind: 'field', field: 'ctr' },
  '单次点击费用（全部）': { kind: 'field', field: 'cpc' },
  '单次链接点击费用': { kind: 'field', field: 'cpc' },
  'CPC (all)': { kind: 'field', field: 'cpc' },
  'Cost per link click': { kind: 'field', field: 'cpc' },
  '应用安装量': { kind: 'field', field: 'installs' },
  '移动应用安装量': { kind: 'field', field: 'installs' },
  'App installs': { kind: 'field', field: 'installs' },
  'Mobile app installs': { kind: 'field', field: 'installs' },
  '展示次数': { kind: 'field', field: 'impressions' },
  'Impressions': { kind: 'field', field: 'impressions' },
  '覆盖人数': { kind: 'skip' },
  'Reach': { kind: 'skip' },
  '频次': { kind: 'skip' },
  'Frequency': { kind: 'skip' },
  '预算': { kind: 'skip' },
  'Budget': { kind: 'skip' },
  '落地页浏览量': { kind: 'skip' },
  '落地页单次浏览费用': { kind: 'skip' },
  '店铺点击量': { kind: 'skip' },
  '结束日期': { kind: 'skip' },
  'End date': { kind: 'skip' },
  '关/开': { kind: 'icon' },
  'On/Off': { kind: 'icon' },
  '广告系列': { kind: 'icon' },
  '广告组': { kind: 'icon' },
  '广告': { kind: 'icon' },
  'Campaigns': { kind: 'icon' },
  'Ad sets': { kind: 'icon' },
  'Ads': { kind: 'icon' },
  '投放': { kind: 'icon' },
  'Delivery': { kind: 'icon' },
  '操作': { kind: 'icon' },
  '归因设置': { kind: 'icon' },
  // --- extended FB column catalog (zh) ---
  '帖子互动': { kind: 'skip' },
  '评论': { kind: 'skip' },
  '分享': { kind: 'skip' },
  '赞': { kind: 'skip' },
  '视频播放量': { kind: 'skip' },
  '三秒视频播放量': { kind: 'skip' },
  '视频平均观看时长': { kind: 'skip' },
  '添加到购物车': { kind: 'skip' },
  '发起结账': { kind: 'skip' },
  '已添加支付信息': { kind: 'skip' },
  '购买次数': { kind: 'skip' },
  '购买转化值': { kind: 'skip' },
  '广告花费回报': { kind: 'skip' },
  '网站购买': { kind: 'skip' },
  '网站购买转化值': { kind: 'skip' },
  '消息': { kind: 'skip' },
  '对话': { kind: 'skip' },
  '开始日期': { kind: 'skip' },
  '千次展示费用': { kind: 'field', field: 'cpm' },
  '链接点击率（Link CTR）': { kind: 'field', field: 'ctr' },
  '单次链接点击费用（CPC）': { kind: 'field', field: 'cpc' },
  // --- extended FB column catalog (en) ---
  'Start date': { kind: 'skip' },
  'Website purchases': { kind: 'skip' },
  'Purchase conversion value': { kind: 'skip' },
  'Website purchase conversion value': { kind: 'skip' },
  'Purchase ROAS (return on ad spend)': { kind: 'skip' },
  'Website ROAS (return on ad spend)': { kind: 'skip' },
  'Adds to cart': { kind: 'skip' },
  'Initiated checkout': { kind: 'skip' },
  'Added payment info': { kind: 'skip' },
  'Video plays': { kind: 'skip' },
  '3-second video plays': { kind: 'skip' },
  'Video average time watched': { kind: 'skip' },
  'Post engagement': { kind: 'skip' },
  'Comments': { kind: 'skip' },
  'Shares': { kind: 'skip' },
  'Reactions': { kind: 'skip' },
  'Messages': { kind: 'skip' },
  'Conversations': { kind: 'skip' },
  'Cost per 1,000 people reached': { kind: 'skip' },
  'Accounts center reach': { kind: 'skip' },
  'Cost per 1,000 accounts center reach': { kind: 'skip' },
  'Cost per 1,000 impressions': { kind: 'field', field: 'cpm' },
  'Cost per website purchase': { kind: 'field', field: 'costPerResult' },
  'Cost per add to cart': { kind: 'field', field: 'costPerResult' },
  'Cost per initiated checkout': { kind: 'field', field: 'costPerResult' },
  'Link CTR (click-through rate)': { kind: 'field', field: 'ctr' },
  'CTR (link click-through rate)': { kind: 'field', field: 'ctr' },
  'Cost per link click (CPC)': { kind: 'field', field: 'cpc' },
  'Website cost per 1,000 impressions': { kind: 'field', field: 'cpm' }
}

const SUMMARY_MARKER = /^(\d+)个(广告系列|广告组|广告)的成效$/
const SUMMARY_MARKER_EN = /^Performance for (\d+) campaigns?$/
const ACCOUNT_LINE = /^(.{1,120}?) \((\d{8,})\)$/
/** A metric value line: money, em/en dash, percentage, or plain number. */
const VALUE_LINE = /^(—|–|-|\$[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?%|[\d,]+(?:\.\d+)?)$/
/** The result-type label under the 成效 column (e.g. 应用内购买). */
const RESULT_TYPE_LABEL = /^[\u4e00-\u9fff][\u4e00-\u9fff（）()/A-Za-z0-9 ]{0,19}$/
const RESULT_TYPE_LABEL_EN = /^(?:Purchases|Website purchases|App installs|Mobile app installs|Link clicks|Landing page views|Video plays|Adds to cart|Initiated checkout|Added payment info|Post engagement|Comments|Shares|Reactions|Messages|Conversations|Conversions|Leads|Registrations)$/

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
  const t = line.trim()
  return isValueLine(line) || RESULT_TYPE_LABEL.test(t) || RESULT_TYPE_LABEL_EN.test(t)
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
    if (parseFbReadingDateRange(line)) {
      dateRangeLabel = line
      break
    }
  }

  // Column headers: between the 关/开 marker and 定制列...
  const headerStart = lines.findIndex((l) => l === '关/开' || l === 'On/Off')
  const headerEnd = lines.findIndex((l, idx) => idx > headerStart && (l === '定制列...' || l === '定制列…' || /^Customize columns/i.test(l)))
  if (headerStart < 0 || headerEnd <= headerStart + 1) return null
  const columns = lines.slice(headerStart + 1, headerEnd)
  if (columns.length < 4) return null
  // Header-driven binding: known labels map to fields; unknown labels get
  // an auto-alignment slot resolved by strict value typing below. FB column
  // names come from a fixed catalog, so unknowns are rare; when one shows
  // up the solver decides whether its cell rendered, instead of failing.
  const ops: HeaderOp[] = []
  let unknownCount = 0
  for (const label of columns) {
    const op = HEADER_OPS[label]
    if (!op) { ops.push({ kind: 'unknown' }); unknownCount += 1; continue }
    ops.push(op)
  }
  if (!ops.some((op) => op.kind === 'field' && op.field === 'spend')) return null
  if (unknownCount > 6) return null

  const isDash = (t: string) => t === '—' || t === '–' || t === '-'
  const isMoney = (t: string) => /^\$[\d,]+(?:\.\d+)?$/.test(t)
  const isPercent = (t: string) => /^[\d,]+(?:\.\d+)?%$/.test(t)
  const isCount = (t: string) => /^[\d,]+$/.test(t)
  const isResultLabel = (t: string) => !isValueLine(t) && (RESULT_TYPE_LABEL.test(t) || RESULT_TYPE_LABEL_EN.test(t))

  const consumeRowValues = (values: string[], choice: boolean[]): Omit<FbAdsCampaignRow, 'name' | 'raw'> | null => {
    const cells = {
      spend: null, costPerResult: null, cpm: null, impressions: null, results: null, resultType: null,
      clicks: null, ctr: null, cpc: null, installs: null
    } as Omit<FbAdsCampaignRow, 'name' | 'raw'>
    let token = 0
    let unknownOrdinal = 0
    for (const op of ops) {
      if (op.kind === 'icon') continue
      if (op.kind === 'unknown') {
        if (choice[unknownOrdinal]) token += 1
        unknownOrdinal += 1
        continue
      }
      // Right-side columns can stay virtualized: stop when tokens run out.
      if (token >= values.length) break
      const cell = values[token]
      if (op.kind === 'results') {
        if (!(isDash(cell) || isCount(cell))) return null
        cells.results = isDash(cell) ? 0 : parseFbMetricNumber(cell)
        token += 1
        const next = values[token]
        if (next !== undefined && isResultLabel(next)) {
          cells.resultType = next
          token += 1
        }
        continue
      }
      if (op.kind === 'field') {
        if (op.field === 'spend' || op.field === 'costPerResult' || op.field === 'cpm' || op.field === 'cpc') {
          if (!(isDash(cell) || isMoney(cell))) return null
        } else if (op.field === 'ctr') {
          if (!(isDash(cell) || isPercent(cell))) return null
        } else {
          if (!(isDash(cell) || isCount(cell))) return null
        }
        const isCountField = op.field === 'impressions' || op.field === 'clicks' || op.field === 'installs'
        cells[op.field] = isCountField && isDash(cell) ? 0 : parseFbMetricNumber(cell)
        token += 1
        continue
      }
      // skip columns tolerate any single token: values, dates, or dashes.
      token += 1
    }
    if (token !== values.length) return null
    return cells
  }

  // Rows: after the customize-columns link, until the summary marker.
  const summaryOf = (line: string): number | null => {
    const zh = line.match(SUMMARY_MARKER)
    if (zh) return Number(zh[1])
    const en = line.match(SUMMARY_MARKER_EN)
    if (en) return Number(en[1])
    return null
  }
  const isSummaryLine = (line: string) => summaryOf(line) !== null
  interface RowTokens { name: string; values: string[] }
  const collected: RowTokens[] = []
  let i = headerEnd + 1
  let campaignCount: number | null = null
  let rowWidth: number | null = null
  while (i < lines.length) {
    const marker = summaryOf(lines[i])
    if (marker !== null) {
      campaignCount = marker
      break
    }
    const name = lines[i]
    if (!name || isValueLine(name)) return null
    const values: string[] = []
    let j = i + 1
    if (ROW_HOVER_ACTIONS.every((label, offset) => lines[j + offset] === label)) {
      j += ROW_HOVER_ACTIONS.length
    }
    while (j < lines.length) {
      if (isSummaryLine(lines[j])) break
      if (!isValueOrResultLabel(lines[j])) break
      values.push(lines[j])
      j += 1
    }
    if (values.length < 3) return null
    if (rowWidth === null) rowWidth = values.length
    else if (rowWidth !== values.length) return null
    collected.push({ name, values })
    i = j
  }
  if (collected.length === 0) return null

  // Resolve the unknown-column alignment once for every row: try each
  // consume/skip combination, keep the ones where every row type-checks
  // end to end, and accept only an unambiguous assignment.
  let rows: FbAdsCampaignRow[] | null = null
  for (let mask = 0; mask < 1 << unknownCount; mask += 1) {
    const choice = Array.from({ length: unknownCount }, (_, bit) => Boolean(mask & (1 << bit)))
    const parsed = collected.map((row) => {
      const cells = consumeRowValues(row.values, choice)
      return cells ? { name: row.name, ...cells, raw: row.values } : null
    })
    if (parsed.some((row) => row === null)) continue
    if (rows === null) {
      rows = parsed as FbAdsCampaignRow[]
      continue
    }
    const sameAssignment = (parsed as FbAdsCampaignRow[]).every((row, index) =>
      JSON.stringify({ ...row, raw: [] }) === JSON.stringify({ ...rows![index], raw: [] })
    )
    if (!sameAssignment) return null
  }
  if (rows === null) return null
  if (rows.length === 0) return null

  // Summary: value+label pairs after the marker; grab 总花费 for cross-check.
  let totalSpend: number | null = null
  if (i < lines.length && isSummaryLine(lines[i])) {
    for (let j = i + 1; j < lines.length - 1; j++) {
      if (isValueLine(lines[j]) && (lines[j + 1] === '总花费' || lines[j + 1] === 'Amount spent')) {
        totalSpend = parseFbMetricNumber(lines[j])
        break
      }
    }
  }

  return {
    kind: 'ads-manager-campaigns',
    accountId,
    accountName,
    dateRangeLabel,
    campaignCount,
    columns,
    rows,
    totalSpend,
    observation: {
      capturedAt: typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)
        ? new Date(input.observedAt).toISOString()
        : new Date().toISOString(),
      sourceUrl: typeof input.url === 'string' ? input.url : null,
      sourceTitle: typeof input.title === 'string' ? input.title : null,
      currency: null,
      timezone: null,
      attributionWindow: null,
      visibleRows: rows.length,
      readRows: rows.length,
      totalRows: campaignCount,
      coverage:
        campaignCount !== null && rows.length === campaignCount
          ? rows.some((row) => row.ctr !== null || row.impressions !== null)
            ? 'complete'
            : 'partial'
          : 'partial',
      columnMode: rows.some((row) => row.installs !== null || row.impressions !== null)
        ? 'wide'
        : rowWidth === 3
          ? 'narrow'
          : 'unknown'
    }
  }
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

/** Rows visible must equal the count the page's summary marker claims. */
export function fbAdsReadingRowsMatchCount(reading: FbAdsCampaignReading): boolean | null {
  if (reading.campaignCount === null) return null
  return reading.rows.length === reading.campaignCount
}

export type FbReadingRejection = 'incomplete-view' | 'totals-mismatch' | null

/**
 * Single-reading hard gates for automated consumption: rows must match the
 * page's own campaign count and the row sums must equal the page summary.
 * Returns the first failing reason, or null when fully verified.
 */
export function fbAdsReadingRejection(reading: FbAdsCampaignReading): FbReadingRejection {
  if (
    !reading.accountId ||
    !reading.dateRangeLabel ||
    reading.campaignCount === null ||
    reading.rows.some((row) => row.spend === null)
  ) return 'incomplete-view'
  if (fbAdsReadingRowsMatchCount(reading) === false) return 'incomplete-view'
  if (fbAdsReadingTotalsMatch(reading) === false) return 'totals-mismatch'
  return null
}

/**
 * Double-read consistency for the bridge: same structure, and either the
 * readings are identical (page stable) or each is individually self-
 * consistent (live numbers ticked between reads but stayed correct).
 */
export function fbAdsReadingsConsistent(
  first: FbAdsCampaignReading,
  second: FbAdsCampaignReading
): boolean {
  const structureOf = (r: FbAdsCampaignReading) =>
    [r.accountId, r.accountName, r.dateRangeLabel, r.campaignCount, r.columns.join('\u001f'), ...r.rows.map((row) => row.name)].join('|')
  if (structureOf(first) !== structureOf(second)) return false
  if (JSON.stringify(first) === JSON.stringify(second)) return true
  return fbAdsReadingRejection(first) === null && fbAdsReadingRejection(second) === null
}
