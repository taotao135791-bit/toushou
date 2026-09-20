import { BoardDataset } from '../../../shared/types'
import { DatasetImportResult, buildDataset } from '../../../shared/datasets'
import { createOrUpdateDataset } from '../../boardDatasets'
import { TikTokReportRow } from './tiktokClient'

/**
 * TikTok 报表 → 看板数据集写入器。把归一化的报表行变成与 CSV 导入完全一致
 * 的 BoardDataset（同一套 buildDataset 类型推断/清洗/上限截断），再通过
 * createOrUpdateDataset 以固定名称 "TikTok 报表" 建立或整体替换。
 */

export const TIKTOK_DATASET_NAME = 'TikTok 报表'

export const TIKTOK_REPORT_GRID_COLUMNS = [
  '日期',
  '活动名称',
  '消耗',
  '展示',
  '点击',
  '点击率',
  '平均点击成本',
  '转化',
  '转化成本'
] as const

/** Report row → raw string grid cell ('' for absent metrics, like CSV blanks). */
function cell(value: number | null): string {
  return value === null ? '' : String(value)
}

/** Pure: normalized rows → header/raw-row grid shaped for buildDataset. */
export function reportRowsToGrid(rows: TikTokReportRow[]): { headers: string[]; rawRows: string[][] } {
  return {
    headers: [...TIKTOK_REPORT_GRID_COLUMNS],
    rawRows: rows.map((row) => [
      row.date,
      row.campaignName,
      cell(row.spend),
      cell(row.impressions),
      cell(row.clicks),
      cell(row.ctr),
      cell(row.cpc),
      cell(row.conversion),
      cell(row.costPerConversion)
    ])
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
  file?: string
): DatasetImportResult {
  const grid = reportRowsToGrid(rows)
  const built = buildDataset(grid.headers, grid.rawRows)
  return createOrUpdateDataset(TIKTOK_DATASET_NAME, built, file)
}

/** Type guard helpers for tests and callers that only need the written shape. */
export function isTikTokReportDataset(dataset: BoardDataset): boolean {
  return dataset.name === TIKTOK_DATASET_NAME
}
