import type { BoardDataset } from '../../../shared/types'
import { DATASET_LIMITS, type DatasetImportResult } from '../../../shared/datasets'
import { listDatasetsStrict, writeDatasets } from '../../boardDatasets'
import type { TikTokReportRow } from './tiktokClient'

export const TIKTOK_DATASET_NAME = 'TikTok 报表'
const LEGACY_PREFIX = 'TikTok 报表（旧数据备份）'
const SOURCE = 'tiktok-report-v2' as const
export const TIKTOK_REPORT_GRID_COLUMNS = [
  '日期', '广告主', '活动名称', '消耗', '展示', '点击', '点击率', '平均点击成本', '转化', '转化成本', '币种', '广告主ID', '活动ID', '账户时区', '数据来源'
] as const
export interface TikTokAdvertiserDetail { name: string | null; currency: string | null; timezone?: string | null }
/** Each scope is a COMPLETE, successfully fetched account/date window. */
export interface TikTokDatasetScope { advertiserId: string; startDate: string; endDate: string; source?: 'mcp' | 'open-api' }
type TaggedDataset = BoardDataset & { source?: typeof SOURCE }

// Successful commits are tracked by account and calendar day. A failed newer
// request does not prevent an older successful response from being saved.
let requestSequence = 0
const committedVersions = new Map<string, number>()
export function beginTikTokDatasetRead(): number { return ++requestSequence }
function scopeKeys(file: string | undefined, scopes: TikTokDatasetScope[]): string[] {
  const keys: string[] = []
  for (const scope of scopes) {
    const last = Date.parse(`${scope.endDate}T00:00:00Z`)
    for (let day = Date.parse(`${scope.startDate}T00:00:00Z`); day <= last; day += 86_400_000) {
      keys.push(JSON.stringify([file ?? '', scope.advertiserId, new Date(day).toISOString().slice(0, 10)]))
    }
  }
  return keys
}

function cell(value: number | null): string { return value === null ? '' : String(value) }
export function reportRowsToGrid(rows: TikTokReportRow[], details?: ReadonlyMap<string, TikTokAdvertiserDetail>): { headers: string[]; rawRows: string[][] } {
  return { headers: [...TIKTOK_REPORT_GRID_COLUMNS], rawRows: rows.map((row) => {
    const detail = row.advertiserId ? details?.get(row.advertiserId) : undefined
    const ctr = row.ctr ?? (row.impressions && row.clicks !== null ? row.clicks / row.impressions * 100 : null)
    const cpc = row.cpc ?? (row.clicks && row.spend !== null ? row.spend / row.clicks : null)
    const cpa = row.costPerConversion ?? (row.conversion && row.spend !== null ? row.spend / row.conversion : null)
    return [row.date, detail?.name?.trim() || row.advertiserId || '', row.campaignName, cell(row.spend), cell(row.impressions), cell(row.clicks), cell(ctr), cell(cpc), cell(row.conversion), cell(cpa), detail?.currency ?? '', row.advertiserId ?? '', row.campaignId ?? '', detail?.timezone ?? '', '']
  }) }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[1-9]\d{0,24}$/
function validDate(day: string): boolean {
  if (!DATE.test(day)) return false
  const d = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === day
}
function validSchema(dataset: TaggedDataset): boolean {
  if (dataset.source !== SOURCE || dataset.columns.length !== TIKTOK_REPORT_GRID_COLUMNS.length ||
      !dataset.columns.every((column, index) => column.name === TIKTOK_REPORT_GRID_COLUMNS[index])) return false
  const keys = new Set<string>()
  return dataset.rows.every((row) => {
    if (row.length !== TIKTOK_REPORT_GRID_COLUMNS.length || !ID.test(String(row[11])) || !ID.test(String(row[12])) || !validDate(String(row[0]))) return false
    const key = `${row[11]}:${row[12]}:${row[0]}`
    if (keys.has(key) || ![3, 4, 5, 8].every((i) => typeof row[i] === 'number' && Number.isFinite(row[i]) && Number(row[i]) >= 0) ||
        !['mcp', 'open-api'].includes(String(row[14]))) return false
    keys.add(key)
    return true
  })
}
function createColumns(): BoardDataset['columns'] {
  return TIKTOK_REPORT_GRID_COLUMNS.map((name, index) => ({ name, type: index === 0 ? 'date' : index >= 3 && index <= 9 ? 'number' : 'text' }))
}
function typedRows(rows: TikTokReportRow[], details: ReadonlyMap<string, TikTokAdvertiserDetail> | undefined, scopes: TikTokDatasetScope[]): BoardDataset['rows'] {
  const grid = reportRowsToGrid(rows, details)
  return grid.rawRows.map((row) => row.map((v, i) => i === 14 ? (scopes.find((scope) => scope.advertiserId === row[11] && row[0] >= scope.startDate && row[0] <= scope.endDate)?.source ?? 'mcp') : i >= 3 && i <= 9 && v !== '' ? Number(v) : v))
}
function inferScope(rows: TikTokReportRow[]): TikTokDatasetScope[] {
  const byId = new Map<string, {startDate: string; endDate: string}>()
  for (const row of rows) {
    if (!row.advertiserId) return []
    const prev = byId.get(row.advertiserId)
    byId.set(row.advertiserId, { startDate: prev && prev.startDate < row.date ? prev.startDate : row.date, endDate: prev && prev.endDate > row.date ? prev.endDate : row.date })
  }
  return [...byId].map(([advertiserId, window]) => ({ advertiserId, ...window }))
}
function backupName(datasets: BoardDataset[]): string {
  const names = new Set(datasets.map((dataset) => dataset.name))
  if (!names.has(LEGACY_PREFIX)) return LEGACY_PREFIX
  for (let i = 2; i <= names.size + 2; i++) if (!names.has(`${LEGACY_PREFIX} ${i}`)) return `${LEGACY_PREFIX} ${i}`
  throw new Error('backup name exhausted')
}

/** Compatibility entry point; safety still requires stable IDs. */
export function writeReportToDataset(rows: TikTokReportRow[], file?: string, details?: ReadonlyMap<string, TikTokAdvertiserDetail>): DatasetImportResult {
  return mergeReportRowsIntoDataset(rows, details, file)
}

/** Atomic account/window replacement; old unknown data is backed up separately. */
export function mergeReportRowsIntoDataset(
  rows: TikTokReportRow[],
  details?: ReadonlyMap<string, TikTokAdvertiserDetail>,
  file?: string,
  explicitScope?: TikTokDatasetScope[],
  requestVersion?: number,
  beforeCommit?: (candidate: BoardDataset) => void
): DatasetImportResult {
  const scopes = explicitScope ?? inferScope(rows)
  if (!scopes.length || new Set(scopes.map((scope) => scope.advertiserId)).size !== scopes.length || scopes.some((scope) => !ID.test(scope.advertiserId) || !validDate(scope.startDate) || !validDate(scope.endDate) || scope.startDate > scope.endDate || (scope.source !== undefined && scope.source !== 'mcp' && scope.source !== 'open-api'))) return { ok: false, error: 'invalid-scope' }
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row.advertiserId ?? '', campaign = row.campaignId ?? ''
    const key = `${id}:${campaign}:${row.date}`
    if (!ID.test(id) || !ID.test(campaign) || !validDate(row.date) || seen.has(key) || !scopes.some((scope) => scope.advertiserId === id && row.date >= scope.startDate && row.date <= scope.endDate)) return { ok: false, error: 'invalid-scope' }
    if ([row.spend, row.impressions, row.clicks, row.conversion].some((value) => value === null || !Number.isFinite(value) || value < 0) || [row.ctr, row.cpc, row.costPerConversion].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) return { ok: false, error: 'invalid-scope' }
    seen.add(key)
  }
  const keys = requestVersion === undefined ? [] : scopeKeys(file, scopes)
  if (requestVersion !== undefined && keys.some((key) => (committedVersions.get(key) ?? 0) > requestVersion)) return { ok: false, error: 'superseded' }
  let datasets: BoardDataset[]
  try { datasets = listDatasetsStrict(file) } catch { return { ok: false, error: 'dataset-store-unreadable' } }
  const matches = datasets.filter((dataset) => dataset.name === TIKTOK_DATASET_NAME)
  if (matches.length > 1) return { ok: false, error: 'ambiguous-dataset' }
  const existing = matches[0] as TaggedDataset | undefined
  // Reusing a shared ID could redirect a board binding to an unrelated table.
  if (existing && datasets.some((dataset) => dataset !== existing && dataset.id === existing.id)) return { ok: false, error: 'ambiguous-dataset' }
  const legacy = existing && !validSchema(existing)
  if ((!existing || legacy) && datasets.length >= DATASET_LIMITS.maxDatasets) return { ok: false, error: 'dataset-limit' }
  const kept = existing && !legacy ? existing.rows.filter((row) => !scopes.some((scope) => String(row[11]) === scope.advertiserId && String(row[0]) >= scope.startDate && String(row[0]) <= scope.endDate)) : []
  if (kept.length + rows.length > DATASET_LIMITS.maxRows) return { ok: false, error: 'row-limit' }
  const merged: TaggedDataset = {
    ...(!legacy && existing ? existing : {}),
    id: existing?.id ?? crypto.randomUUID(), name: TIKTOK_DATASET_NAME, columns: createColumns(),
    rows: [...kept, ...typedRows(rows, details, scopes)], createdAt: existing?.createdAt ?? Date.now(), source: SOURCE
  }
  const next = datasets.filter((dataset) => dataset !== existing)
  if (legacy && existing) next.push({ ...existing, id: crypto.randomUUID(), name: backupName(datasets) })
  next.push(merged)
  try { beforeCommit?.(merged) } catch { return { ok: false, error: 'write-failed', detail: 'proof-failed' } }
  try { writeDatasets(file, next) } catch { return { ok: false, error: 'write-failed' } }
  if (requestVersion !== undefined) for (const key of keys) committedVersions.set(key, requestVersion)
  const legacyBackups = next.filter((dataset) => dataset.name.startsWith(LEGACY_PREFIX)).map((dataset) => dataset.name)
  return { ok: true, dataset: merged, truncated: false, ...(legacyBackups.length ? { legacyBackups } : {}) }
}

export function isTikTokReportDataset(dataset: BoardDataset): boolean { return dataset.name === TIKTOK_DATASET_NAME }
