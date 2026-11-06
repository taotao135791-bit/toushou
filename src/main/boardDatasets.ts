import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { BoardDataset } from '../shared/types'
import { validateAppsFlyerDatasetState, type AppsFlyerDatasetState } from '../shared/appsflyerDataset'
import { boardStoragePath } from './boardBuildStorage'
import { listBoards } from './boards'
import { boardWidgetDatasetBindings } from '../shared/boardDataWidgets'
import {
  DATASET_FILE_EXTENSIONS,
  DATASET_LIMITS,
  DatasetImportResult,
  DatasetMutationResult,
  BuiltDataset,
  buildDataset,
  isValidDatasetId,
  isValidDatasetName,
  validateDataset
} from '../shared/datasets'

/**
 * Board dataset persistence + import — a single JSON document at
 * userData/board-datasets.json, written atomically (tmp + rename, same as
 * boards.ts). importDataset is the only file-import writer: IPC resolves an
 * opaque FileGrant to a trusted, Main-held CSV/XLSX path before this function
 * reads it. It then parses a raw string grid (papaparse / xlsx) and lets the
 * shared pure layer infer types and clean values. createOrUpdateDataset is
 * the structured in-Main writer (TikTok 报表 refresh): same storage, same
 * validation, replace-by-name instead of append. Every read re-validates via
 * validateDataset; a missing file is empty, while a corrupt/unreadable store
 * is surfaced and protected from destructive writes.
 */

function defaultDatasetsFile(): string {
  return boardStoragePath('board-datasets.json')
}
export const DATASET_CACHE_LIMIT = 128
export const DATASET_STORE_MAX_BYTES = 256 * 1024 * 1024
const isCache = (dataset: BoardDataset): boolean => !!dataset.appsflyer?.materialization
/** Only unreachable Main-owned materializations are collected. Base datasets
 * are never evicted, even when a legacy store exceeds its normal quota. */
function collectUnusedCaches(datasets: BoardDataset[]): BoardDataset[] {
  if (!datasets.some(isCache) || !existsSync(boardStoragePath('kanban-boards-v2.json'))) return datasets
  try {
    const boards = listBoards()
    return datasets.filter(dataset => {
      const slot = dataset.appsflyer?.materialization
      if (!slot) return true
      const board = boards.find(item => item.id === slot.boardId)
      return !!board?.widgets.some(widget => JSON.stringify(widget.dateScope ?? { mode: 'inherit' }) === slot.scopeKey && boardWidgetDatasetBindings(widget).some(binding => {
        const original = datasets.find(item => item.id === binding.datasetId || item.name === binding.datasetId)
        return !!original && !isCache(original) && original.id === slot.bindingDatasetId
      }))
    })
  } catch { return datasets }
}

function readDatasets(file: string): BoardDataset[] {
  let text: string
  try {
    if (statSync(file).size > DATASET_STORE_MAX_BYTES) throw new Error('dataset-store-too-large')
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (error instanceof Error && error.message === 'dataset-store-too-large') throw error
    throw new Error('Could not read the local datasets file.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The local datasets file is not valid JSON.')
  }
  if (!Array.isArray(raw)) {
    throw new Error('The local datasets file has an invalid format.')
  }
  const datasets: BoardDataset[] = []
  for (const entry of raw) {
    const dataset = validateDataset(entry)
    if (dataset) datasets.push(dataset)
  }
  return datasets
}

export function writeDatasets(file: string = defaultDatasetsFile(), datasets: BoardDataset[]): void {
  const serialized = JSON.stringify(datasets, null, 2) + '\n'
  if (Buffer.byteLength(serialized, 'utf8') > DATASET_STORE_MAX_BYTES) throw new Error('dataset-store-too-large')
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, serialized, 'utf-8')
  renameSync(tmp, file)
}

export function listDatasets(file: string = defaultDatasetsFile()): BoardDataset[] {
  return readDatasets(file)
}

/** Keep previous rows on a failed query, while persisting that they are stale. */
export function updateDatasetAppsFlyerState(
  id: string,
  state: AppsFlyerDatasetState,
  file: string = defaultDatasetsFile()
): DatasetMutationResult {
  const validated = validateAppsFlyerDatasetState(state)
  if (!isValidDatasetId(id) || !validated) return { ok: false, error: 'invalid-dataset' }
  try {
    const datasets = readDatasets(file)
    const index = datasets.findIndex(dataset => dataset.id === id)
    if (index < 0) return { ok: false, error: 'not-found' }
    datasets[index] = { ...datasets[index], appsflyer: validated }
    writeDatasets(file, datasets)
    return { ok: true }
  } catch {
    return { ok: false, error: 'dataset-store-unreadable' }
  }
}

/** Strict read for migrations: refuse invalid rows rather than dropping them. */
export function listDatasetsStrict(file: string = defaultDatasetsFile()): BoardDataset[] {
  let text: string
  try {
    if (statSync(file).size > DATASET_STORE_MAX_BYTES) throw new Error('dataset-store-too-large')
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (error instanceof Error && error.message === 'dataset-store-too-large') throw error
    throw new Error('Could not read the local datasets file.')
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('The local datasets file is not valid JSON.') }
  if (!Array.isArray(raw) || raw.some((item) => !validateDataset(item))) {
    throw new Error('The local datasets file contains an invalid dataset.')
  }
  // Preserve extra fields verbatim for backups; validation above establishes
  // the required BoardDataset shape without silently rewriting unknown data.
  return raw as BoardDataset[]
}

export function deleteDataset(id: unknown, file: string = defaultDatasetsFile()): DatasetMutationResult {
  if (!isValidDatasetId(id)) return { ok: false, error: 'invalid-dataset' }
  let datasets: BoardDataset[]
  try {
    datasets = readDatasets(file)
  } catch {
    return { ok: false, error: 'dataset-store-unreadable' }
  }
  const next = datasets.filter((d) => d.id !== id)
  // Deleting an absent dataset is an idempotent no-op — skip the write.
  if (next.length === datasets.length) return { ok: true }
  try {
    writeDatasets(file, next)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function renameDataset(
  id: unknown,
  name: unknown,
  file: string = defaultDatasetsFile()
): DatasetMutationResult {
  if (!isValidDatasetId(id) || !isValidDatasetName(name)) {
    return { ok: false, error: 'invalid-dataset' }
  }
  let datasets: BoardDataset[]
  try {
    datasets = readDatasets(file)
  } catch {
    return { ok: false, error: 'dataset-store-unreadable' }
  }
  const dataset = datasets.find((d) => d.id === id)
  if (!dataset) return { ok: false, error: 'not-found' }
  if (dataset.name === name) return { ok: true }
  dataset.name = name
  try {
    writeDatasets(file, datasets)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Import — extension dispatch, size guard, parse, build, persist.
// ---------------------------------------------------------------------------

function datasetNameFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.(csv|xlsx?|xls)$/i, '').trim()
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, DATASET_LIMITS.maxNameLength)
  return cleaned || 'dataset'
}

/** Raw string grid of a CSV text (first row = headers). */
function parseCsvGrid(text: string): string[][] {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    skipEmptyLines: 'greedy'
  })
  return result.data.filter((r) => Array.isArray(r))
}

/** Raw string grid of the first sheet of an XLSX/XLS buffer. */
function parseXlsxGrid(buffer: Buffer): string[][] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: ''
  })
  return aoa
    .filter((r) => Array.isArray(r) && r.length > 0)
    .map((r) => r.map((c) => String(c ?? '')))
}

export function importDataset(
  filePath: unknown,
  file: string = defaultDatasetsFile(),
  asName?: string
): DatasetImportResult {
  // eslint-disable-next-line no-control-regex
  if (typeof filePath !== 'string' || !filePath || /[\x00-\x1f\x7f]/.test(filePath)) {
    return { ok: false, error: 'invalid-path' }
  }
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!DATASET_FILE_EXTENSIONS.includes(ext as (typeof DATASET_FILE_EXTENSIONS)[number])) {
    return { ok: false, error: 'unsupported-type' }
  }
  if (!existsSync(filePath)) return { ok: false, error: 'invalid-path' }

  try {
    if (statSync(filePath).size > DATASET_LIMITS.maxFileBytes) return { ok: false, error: 'file-too-large' }
    return importDatasetBuffer(filePath, readFileSync(filePath), file, asName)
  } catch {
    return { ok: false, error: 'read-failed' }
  }
}

/** Parse bytes already opened and authorized by Main without reopening a path. */
export function importDatasetBuffer(
  fileName: string,
  bytes: Buffer,
  file: string = defaultDatasetsFile(),
  asName?: string
): DatasetImportResult {
  // eslint-disable-next-line no-control-regex
  if (typeof fileName !== 'string' || !fileName || /[\x00-\x1f\x7f]/.test(fileName)) return { ok: false, error: 'invalid-path' }
  const ext = path.extname(fileName).slice(1).toLowerCase()
  if (!DATASET_FILE_EXTENSIONS.includes(ext as (typeof DATASET_FILE_EXTENSIONS)[number])) return { ok: false, error: 'unsupported-type' }
  if (!Buffer.isBuffer(bytes)) return { ok: false, error: 'read-failed' }
  if (bytes.length > DATASET_LIMITS.maxFileBytes) return { ok: false, error: 'file-too-large' }
  let grid: string[][]
  try {
    grid = ext === 'csv' ? parseCsvGrid(bytes.toString('utf8')) : parseXlsxGrid(bytes)
  } catch (err) {
    return { ok: false, error: 'parse-failed', detail: err instanceof Error ? err.message : String(err) }
  }
  if (grid.length === 0) return { ok: false, error: 'empty' }

  const [headers, ...rawRows] = grid
  const built = buildDataset(headers.map((h) => String(h ?? '')), rawRows)
  if (built.columns.length === 0) return { ok: false, error: 'empty' }

  let datasets: BoardDataset[]
  try {
    datasets = readDatasets(file)
  } catch {
    return { ok: false, error: 'dataset-store-unreadable' }
  }
  // An explicit name (agent imports for a template binding) REPLACES the
  // same-named dataset — refresh semantics, so the "TikTok 报表" binding
  // target stays single and up to date instead of accumulating copies.
  // eslint-disable-next-line no-control-regex
  const explicitName =
    typeof asName === 'string' && asName.trim() && !/[\x00-\x1f\x7f]/.test(asName)
      ? asName.trim().slice(0, DATASET_LIMITS.maxNameLength)
      : null
  if (explicitName && datasets.some(dataset => dataset.name === explicitName && isCache(dataset))) return { ok: false, error: 'invalid-name' }
  if (datasets.filter(dataset => !isCache(dataset)).length >= DATASET_LIMITS.maxDatasets) {
    // A replace-by-name import removes one entry before adding — it must not
    // hit the cap (the agent's「TikTok 报表」fill flow relies on this).
    const replaces = explicitName !== null && datasets.some((dataset) => dataset.name === explicitName)
    if (!replaces) return { ok: false, error: 'dataset-limit' }
  }
  // Replace-by-name keeps the existing id/createdAt: widgets bound by dataset
  // ID (the widget settings store d.id) must survive an import that refreshes
  // the same dataset.
  const replaced = explicitName ? datasets.find((existing) => existing.name === explicitName) : undefined
  const dataset: BoardDataset = {
    id: replaced?.id ?? crypto.randomUUID(),
    name: explicitName ?? datasetNameFromPath(fileName),
    columns: built.columns,
    rows: built.rows,
    createdAt: replaced?.createdAt ?? Date.now()
  }
  const next = explicitName
    ? datasets.filter((existing) => existing.name !== dataset.name)
    : datasets
  try {
    writeDatasets(file, [...next, dataset])
  } catch (err) {
    return {
      ok: false,
      error: 'write-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: true, dataset, truncated: built.truncated }
}

// ---------------------------------------------------------------------------
// Structured upsert — Main-internal report writers (TikTok 报表 refresh).
// Same storage + validation as file import, but replace-by-name so repeated
// refreshes update ONE dataset instead of accumulating copies.
// ---------------------------------------------------------------------------

export function createOrUpdateDataset(
  name: unknown,
  built: BuiltDataset,
  file: string = defaultDatasetsFile(),
  options: { replaceId?: string; appsflyer?: BoardDataset['appsflyer'] } = {}
): DatasetImportResult {
  if (!isValidDatasetName(name)) return { ok: false, error: 'invalid-name' }
  if (built.columns.length === 0) return { ok: false, error: 'empty' }
  let datasets: BoardDataset[]
  try {
    datasets = readDatasets(file)
  } catch {
    return { ok: false, error: 'dataset-store-unreadable' }
  }
  const internal = !!options.appsflyer?.materialization
  if (internal) datasets = collectUnusedCaches(datasets)
  const index = datasets.findIndex((d) => options.replaceId ? d.id === options.replaceId : d.name === name)
  if (options.replaceId && index < 0) return { ok: false, error: 'not-found' }
  if (index >= 0 && isCache(datasets[index]) !== internal) return { ok: false, error: 'invalid-name' }
  if (index < 0 && internal && datasets.filter(isCache).length >= DATASET_CACHE_LIMIT) return { ok: false, error: 'dataset-cache-limit' }
  if (index < 0 && !internal && datasets.filter(dataset => !isCache(dataset)).length >= DATASET_LIMITS.maxDatasets) {
    return { ok: false, error: 'dataset-limit' }
  }
  const dataset: BoardDataset = {
    // Replace-by-name keeps the existing id/createdAt so widget bindings that
    // reference the dataset id survive a refresh.
    id: index >= 0 ? datasets[index].id : crypto.randomUUID(),
    name: options.replaceId && index >= 0 ? datasets[index].name : name as string,
    columns: built.columns,
    rows: built.rows,
    createdAt: index >= 0 ? datasets[index].createdAt : Date.now(),
    ...(options.appsflyer ? { appsflyer: options.appsflyer } : {})
  }
  const next =
    index >= 0
      ? datasets.map((d, i) => (i === index ? dataset : d))
      : [...datasets, dataset]
  try {
    writeDatasets(file, next)
  } catch (err) {
    return {
      ok: false,
      error: 'write-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: true, dataset, truncated: built.truncated }
}
