import { BoardDataset } from '../../../shared/types'
import { DatasetImportResult, buildDataset } from '../../../shared/datasets'
import { createOrUpdateDataset, listDatasets, writeDatasets } from '../../boardDatasets'
import { TikTokReportRow } from './tiktokClient'

/**
 * TikTok 报表 → 看板数据集写入器。把归一化的报表行变成与 CSV 导入完全一致
 * 的 BoardDataset（同一套 buildDataset 类型推断/清洗/上限截断），再通过
 * createOrUpdateDataset 以固定名称 "TikTok 报表" 建立或整体替换。
 */

export const TIKTOK_DATASET_NAME = 'TikTok 报表'

export const TIKTOK_REPORT_GRID_COLUMNS = [
  '日期',
  '广告主',
  '活动名称',
  '消耗',
  '展示',
  '点击',
  '点击率',
  '平均点击成本',
  '转化',
  '转化成本',
  '币种'
] as const

/** Per-advertiser detail the refresh gathers alongside the rows. */
export interface TikTokAdvertiserDetail {
  name: string | null
  currency: string | null
}

/** Report row → raw string grid cell ('' for absent metrics, like CSV blanks). */
function cell(value: number | null): string {
  return value === null ? '' : String(value)
}

/** Pure: normalized rows → header/raw-row grid shaped for buildDataset.
 *  `details` (advertiser id → {name, currency}) fills the per-row 广告主 and
 *  币种 columns: one board's cards can filter to ONE advertiser, and money
 *  widgets can offer a USD conversion subtitle. */
export function reportRowsToGrid(
  rows: TikTokReportRow[],
  details?: ReadonlyMap<string, TikTokAdvertiserDetail>
): { headers: string[]; rawRows: string[][] } {
  return {
    headers: [...TIKTOK_REPORT_GRID_COLUMNS],
    rawRows: rows.map((row) => {
      const detail = row.advertiserId ? details?.get(row.advertiserId) : undefined
      // Derived rates: the MCP report request asks only for counts, so ctr /
      // cpc / cost-per-conversion arrive null — compute them from the counts,
      // otherwise the columns stay empty strings and "average CTR" reads 0.
      const ctr = row.ctr ?? (row.impressions && row.clicks !== null ? (row.clicks / row.impressions) * 100 : null)
      const cpc = row.cpc ?? (row.clicks ? (row.spend ?? 0) / row.clicks : null)
      const cpa = row.costPerConversion ?? (row.conversion ? (row.spend ?? 0) / row.conversion : null)
      return [
        row.date,
        detail?.name?.trim() || row.advertiserId || '',
        row.campaignName,
        cell(row.spend),
        cell(row.impressions),
        cell(row.clicks),
        cell(ctr),
        cell(cpc),
        cell(row.conversion),
        cell(cpa),
        detail?.currency ?? ''
      ]
    })
  }
}

/**
 * Create-or-replace the "TikTok 报表" dataset from report rows. Rows are
 * sorted date-desc by the client already; the grid passes through the SAME
 * buildDataset pipeline as CSV import, so column types (日期=date, 指标=
 * number), value cleaning and DATASET_LIMITS enforcement behave identically.
 */
export function writeReportToDataset(
  rows: TikTokReportRow[],
  file?: string,
  details?: ReadonlyMap<string, TikTokAdvertiserDetail>
): DatasetImportResult {
  const grid = reportRowsToGrid(rows, details)
  const built = buildDataset(grid.headers, grid.rawRows)
  return createOrUpdateDataset(TIKTOK_DATASET_NAME, built, file)
}

/**
 * Incremental merge for the TT reading pipeline: upsert the rows THIS read
 * covers (keyed 广告主+日期), keep every other date/advertiser untouched.
 * The reading card's window is small — REPLACE (writeReportToDataset) would
 * shrink the dataset to the card's window and destroy trend history; merge
 * keeps one growing shared dataset. Every TT card read feeds the KPI cards
 * from the SAME pull: one pipeline, zero drift.
 */
export function mergeReportRowsIntoDataset(
  rows: TikTokReportRow[],
  details?: ReadonlyMap<string, TikTokAdvertiserDetail>,
  file?: string
): DatasetImportResult {
  if (rows.length === 0) return { ok: false, error: 'empty' }
  const incoming = reportRowsToGrid(rows, details)
  const datasets = listDatasets(file)
  const existing = datasets.find((dataset) => dataset.name === TIKTOK_DATASET_NAME)
  if (!existing) return writeReportToDataset(rows, file, details)
  const dateIdx = existing.columns.findIndex((column) => column.name === '日期')
  const advertiserIdx = existing.columns.findIndex((column) => column.name === '广告主')
  // Schema mismatch (a pre-广告主 dataset from an older app version): merging
  // would append 11-wide rows to 9-wide ones and garble every column index —
  // replace wholesale instead. History outside the pull window is lost once,
  // which the next full refresh (REPORT_RANGE_DAYS) rebuilds.
  if (advertiserIdx < 0 || dateIdx < 0 || existing.columns.length !== incoming.headers.length) {
    return writeReportToDataset(rows, file, details)
  }
  const mergedBuilt = buildDataset(incoming.headers, incoming.rawRows)
  // Advertiser identity must be STABLE across rounds: the 广告主 cell is the
  // NAME when info answered and the raw ID when it did not. Merging an
  // ID-keyed round into NAME-keyed history duplicates every row (double
  // counts spend) and there is no way back without the id — so a round with
  // incomplete advertiser info is REFUSED (the reading card keeps its data;
  // the dataset waits for a clean round).
  const idCell = /^\d{6,}$/
  for (const row of mergedBuilt.rows) {
    if (idCell.test(String(row[advertiserIdx]))) {
      return { ok: false, error: 'incomplete-advertiser-info' }
    }
  }
  // Upgrade old ID-keyed rows to their NAME when this round knows it.
  const upgrades = new Map<string, string>()
  for (const [id, detail] of details ?? []) {
    if (detail.name) upgrades.set(id, detail.name)
  }
  const withKeys = mergedBuilt.rows.map((row) => row)
  const kept = existing.rows.map((row) => {
    const cell = String(row[advertiserIdx])
    return upgrades.has(cell) ? row.map((value, i) => (i === advertiserIdx ? upgrades.get(cell)! : value)) : row
  }).filter((row) => {
    const cell = String(row[advertiserIdx])
    return !withKeys.some((incoming) => String(incoming[advertiserIdx]) === cell && String(incoming[dateIdx]) === String(row[dateIdx]))
  })
  const merged: BoardDataset = {
    ...existing,
    // Column TYPES refresh with the incoming grid: a column first created from
    // empty cells (text) would otherwise stay text forever even after rates
    // become numeric.
    columns: mergedBuilt.columns,
    rows: [...kept, ...withKeys],
    createdAt: existing.createdAt
  }
  const replaced = datasets.map((dataset) => (dataset.name === TIKTOK_DATASET_NAME ? merged : dataset))
  try {
    writeDatasets(file, replaced)
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  return { ok: true, dataset: merged, truncated: mergedBuilt.truncated }
}

/** Type guard helpers for tests and callers that only need the written shape. */
export function isTikTokReportDataset(dataset: BoardDataset): boolean {
  return dataset.name === TIKTOK_DATASET_NAME
}
