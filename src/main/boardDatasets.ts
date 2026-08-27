import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { BoardDataset } from '../shared/types'
import {
  DATASET_FILE_EXTENSIONS,
  DATASET_LIMITS,
  DatasetImportResult,
  DatasetMutationResult,
  buildDataset,
  isValidDatasetId,
  isValidDatasetName,
  validateDataset
} from '../shared/datasets'

/**
 * Board dataset persistence + import — a single JSON document at
 * userData/board-datasets.json, written atomically (tmp + rename, same as
 * boards.ts). importDataset is the only writer: IPC resolves an opaque
 * FileGrant to a trusted, Main-held CSV/XLSX path before this function reads
 * it. It then parses a raw string grid (papaparse / xlsx) and lets the shared
 * pure layer infer types and clean values. Every read re-validates via
 * validateDataset; a missing file is empty, while a corrupt/unreadable store
 * is surfaced and protected from destructive writes.
 */

function defaultDatasetsFile(): string {
  return path.join(app.getPath('userData'), 'board-datasets.json')
}

function readDatasets(file: string): BoardDataset[] {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
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

function writeDatasets(file: string, datasets: BoardDataset[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(datasets, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function listDatasets(file: string = defaultDatasetsFile()): BoardDataset[] {
  return readDatasets(file)
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
  file: string = defaultDatasetsFile()
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

  let grid: string[][]
  try {
    if (statSync(filePath).size > DATASET_LIMITS.maxFileBytes) {
      return { ok: false, error: 'file-too-large' }
    }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
  try {
    if (ext === 'csv') {
      grid = parseCsvGrid(readFileSync(filePath, 'utf-8'))
    } else {
      grid = parseXlsxGrid(readFileSync(filePath))
    }
  } catch (err) {
    return {
      ok: false,
      error: 'parse-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
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
  if (datasets.length >= DATASET_LIMITS.maxDatasets) return { ok: false, error: 'dataset-limit' }
  const dataset: BoardDataset = {
    id: crypto.randomUUID(),
    name: datasetNameFromPath(filePath),
    columns: built.columns,
    rows: built.rows,
    createdAt: Date.now()
  }
  try {
    writeDatasets(file, [...datasets, dataset])
  } catch (err) {
    return {
      ok: false,
      error: 'write-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: true, dataset, truncated: built.truncated }
}
