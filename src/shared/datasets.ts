/**
 * Pure half of board datasets: number/date cleaning, column type inference,
 * dataset construction from raw header/row grids, aggregation helpers and
 * structural validation. No filesystem or parser-library access here — the
 * main process (src/main/boardDatasets.ts) turns CSV/XLSX bytes into raw
 * string grids via papaparse/xlsx and then calls buildDataset; the renderer
 * reuses aggregate/groupAggregate to feed the chart widgets. Behavior mirrors
 * the reference implementation in the user's pi-kanban project.
 */
import { BoardDataset, BoardDatasetColumn } from './types'

export const DATASET_LIMITS = {
  maxDatasets: 20,
  maxFileBytes: 10 * 1024 * 1024,
  maxColumns: 50,
  maxRows: 10000,
  maxNameLength: 200,
  maxColumnNameLength: 200,
  maxIdLength: 100
} as const

export const DATASET_OPS = ['sum', 'avg', 'count', 'max', 'min'] as const
export type DatasetOp = (typeof DATASET_OPS)[number]

/** Distinct dimension values kept before the remainder folds into "other". */
export const GROUP_TOP_N = 20

/** File extensions importDataset accepts (checked before reading). */
export const DATASET_FILE_EXTENSIONS = ['csv', 'xlsx', 'xls'] as const

export type DatasetImportError =
  | 'invalid-path'
  | 'unsupported-type'
  | 'file-too-large'
  | 'read-failed'
  | 'parse-failed'
  | 'empty'
  | 'dataset-limit'
  | 'dataset-store-unreadable'
  | 'write-failed'

export type DatasetImportResult =
  | { ok: true; dataset: BoardDataset; truncated: boolean }
  | { ok: false; error: DatasetImportError; detail?: string }

export type DatasetMutationResult = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Cell cleaning — ad-report number formats and common date shapes.
// ---------------------------------------------------------------------------

/**
 * Clean the number spellings ad backends export:
 * "1,234.56" / "12%" / "$100" / "¥100" / "(100)" (negative). Returns null for
 * anything that isn't fully numeric after stripping those decorations.
 */
export function cleanNumberString(raw: string): number | null {
  let str = raw.trim()
  if (!str) return null
  str = str.replace(/%\s*$/, '')
  str = str.replace(/^[¥￥$]\s*/, '')
  let negative = false
  const parenthesized = str.match(/^\((.*)\)$/)
  if (parenthesized) {
    negative = true
    str = parenthesized[1].trim()
  }
  str = str.replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(str)) return null
  const n = Number.parseFloat(str)
  if (Number.isNaN(n)) return null
  return negative ? -n : n
}

/**
 * Normalize a date string to YYYY-MM-DD. Supports 2024-01-01, 2024/1/1,
 * 2024年1月1日, 20240101 and US-style 01/02/2024 (when the first number
 * exceeds 12 it is treated as the day). Returns null for anything else.
 */
export function parseDateString(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const a = Number.parseInt(m[1], 10)
    const b = Number.parseInt(m[2], 10)
    const [mm, dd] = a > 12 ? [b, a] : [a, b]
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${m[3]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Type inference + dataset construction.
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 50
/** Fraction of non-empty sampled values that must parse to adopt a type. */
const INFER_THRESHOLD = 0.8

/** Infer a column type from sampled raw strings; dates win over numbers. */
export function inferColumnType(samples: string[]): BoardDatasetColumn['type'] {
  const values = samples.map((v) => v.trim()).filter((v) => v !== '')
  if (values.length === 0) return 'text'
  let numHit = 0
  let dateHit = 0
  for (const v of values) {
    // Dates first: "20260104" would otherwise pass as a number.
    if (parseDateString(v)) {
      dateHit += 1
      continue
    }
    if (cleanNumberString(v) !== null) numHit += 1
  }
  if (dateHit / values.length >= INFER_THRESHOLD) return 'date'
  if (numHit / values.length >= INFER_THRESHOLD) return 'number'
  return 'text'
}

export interface BuiltDataset {
  columns: BoardDatasetColumn[]
  rows: (string | number)[][]
  /** True when columns or rows were dropped to satisfy DATASET_LIMITS. */
  truncated: boolean
}

/**
 * Build typed columns/rows from a raw string grid (first row = headers).
 * Number columns store cleaned numbers, date columns normalized YYYY-MM-DD
 * strings, everything else trimmed text; unparseable cells become ''.
 * Fully empty columns (blank header AND blank values) are dropped, and the
 * column/row limits are enforced by truncation.
 */
export function buildDataset(headers: string[], rawRows: string[][]): BuiltDataset {
  const keep: number[] = []
  for (let c = 0; c < headers.length; c++) {
    const headerEmpty = (headers[c] ?? '').trim() === ''
    const valuesEmpty = rawRows.every((r) => (r[c] ?? '').trim() === '')
    if (!(headerEmpty && valuesEmpty)) keep.push(c)
  }
  const kept = keep.slice(0, DATASET_LIMITS.maxColumns)
  const truncatedColumns = keep.length > kept.length

  const usedNames = new Set<string>()
  const columns: BoardDatasetColumn[] = kept.map((c, i) => {
    const base = ((headers[c] ?? '').trim() || `col_${i + 1}`).slice(
      0,
      DATASET_LIMITS.maxColumnNameLength
    )
    // Bindings reference columns by name, so duplicates get a numeric suffix.
    let name = base
    for (let n = 2; usedNames.has(name); n++) {
      name = `${base.slice(0, DATASET_LIMITS.maxColumnNameLength - 6)} (${n})`
    }
    usedNames.add(name)
    const samples = rawRows.slice(0, SAMPLE_SIZE).map((r) => String(r[c] ?? ''))
    return { name, type: inferColumnType(samples) }
  })

  const rows: (string | number)[][] = []
  let truncatedRows = false
  for (const r of rawRows) {
    if (r.every((cell) => String(cell ?? '').trim() === '')) continue
    if (rows.length >= DATASET_LIMITS.maxRows) {
      truncatedRows = true
      break
    }
    rows.push(
      kept.map((c, i) => {
        const raw = String(r[c] ?? '').trim()
        if (raw === '') return ''
        const type = columns[i].type
        if (type === 'number') {
          const n = cleanNumberString(raw)
          return n === null ? '' : n
        }
        if (type === 'date') return parseDateString(raw) ?? raw
        return raw
      })
    )
  }
  return { columns, rows, truncated: truncatedColumns || truncatedRows }
}

// ---------------------------------------------------------------------------
// Aggregation — feeds counter (single value) and chart (labels/points).
// ---------------------------------------------------------------------------

function isPresent(v: string | number): boolean {
  return v !== ''
}

/**
 * Aggregate one column's values. Non-number values are skipped for
 * sum/avg/max/min; count counts present (non-empty) cells. Empty input → 0.
 */
export function aggregate(values: (string | number)[], op: DatasetOp): number {
  if (op === 'count') return values.filter(isPresent).length
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return 0
  switch (op) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'max':
      return Math.max(...nums)
    case 'min':
      return Math.min(...nums)
  }
}

export interface GroupedPoints {
  labels: string[]
  points: number[]
}

/**
 * Group rows by a dimension column and aggregate a metric column per group,
 * returning exactly the labels/points shape the chart widgets render. Groups
 * are ordered by aggregated value descending; beyond GROUP_TOP_N the rest
 * folds into one `otherLabel` bucket. Date dimensions sort chronologically
 * instead (no value ordering), still with Top-N + other applied by value.
 */
export function groupAggregate(
  dataset: BoardDataset,
  dimIndex: number,
  metricIndex: number,
  op: DatasetOp,
  otherLabel: string = 'Other'
): GroupedPoints {
  const dim = dataset.columns[dimIndex]
  const buckets = new Map<string, (string | number)[]>()
  for (const row of dataset.rows) {
    const rawKey = row[dimIndex]
    const key = rawKey === undefined || rawKey === '' ? '(empty)' : String(rawKey)
    const value = row[metricIndex] ?? ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(value)
    else buckets.set(key, [value])
  }
  const entries = [...buckets.entries()].map(([key, values]) => ({
    key,
    values,
    order: aggregate(values, op)
  }))
  if (dim?.type === 'date') {
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    if (entries.length > GROUP_TOP_N) {
      const byValue = [...entries].sort((a, b) => b.order - a.order)
      const keep = new Set(byValue.slice(0, GROUP_TOP_N).map((e) => e.key))
      const top = entries.filter((e) => keep.has(e.key))
      const rest = entries.filter((e) => !keep.has(e.key))
      return toPoints(top, rest, op, otherLabel)
    }
    return toPoints(entries, [], op, otherLabel)
  }
  entries.sort((a, b) => b.order - a.order)
  return toPoints(entries.slice(0, GROUP_TOP_N), entries.slice(GROUP_TOP_N), op, otherLabel)
}

function toPoints(
  top: { key: string; values: (string | number)[] }[],
  rest: { key: string; values: (string | number)[] }[],
  op: DatasetOp,
  otherLabel: string
): GroupedPoints {
  const labels = top.map((e) => e.key)
  const points = top.map((e) => aggregate(e.values, op))
  if (rest.length > 0) {
    labels.push(otherLabel)
    points.push(aggregate(rest.flatMap((e) => e.values), op))
  }
  return { labels, points }
}

/** Column lookup by stored binding name; -1 when absent. */
export function columnIndex(dataset: BoardDataset, name: string): number {
  return dataset.columns.findIndex((c) => c.name === name)
}

// ---------------------------------------------------------------------------
// Validation — datasets crossing IPC or coming back from disk. Lenient per
// dataset like validateBoard is per widget: bad entries are dropped.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

export function isValidDatasetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DATASET_LIMITS.maxIdLength &&
    !CONTROL_RE.test(value)
  )
}

export function isValidDatasetName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= DATASET_LIMITS.maxNameLength &&
    !CONTROL_RE.test(value)
  )
}

export function validateDataset(raw: unknown): BoardDataset | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (!isValidDatasetId(d.id)) return null
  if (!isValidDatasetName(d.name)) return null
  if (!Array.isArray(d.columns) || d.columns.length > DATASET_LIMITS.maxColumns) return null
  const columns: BoardDatasetColumn[] = []
  const seenNames = new Set<string>()
  for (const rawColumn of d.columns) {
    if (!rawColumn || typeof rawColumn !== 'object') return null
    const c = rawColumn as Record<string, unknown>
    if (
      typeof c.name !== 'string' ||
      c.name.length === 0 ||
      c.name.length > DATASET_LIMITS.maxColumnNameLength ||
      (c.type !== 'number' && c.type !== 'date' && c.type !== 'text') ||
      seenNames.has(c.name)
    ) {
      return null
    }
    seenNames.add(c.name)
    columns.push({ name: c.name, type: c.type })
  }
  if (!Array.isArray(d.rows) || d.rows.length > DATASET_LIMITS.maxRows) return null
  const rows: (string | number)[][] = []
  for (const rawRow of d.rows) {
    if (!Array.isArray(rawRow) || rawRow.length > DATASET_LIMITS.maxColumns) return null
    const row: (string | number)[] = []
    for (const cell of rawRow) {
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) return null
        row.push(cell)
      } else if (typeof cell === 'string') {
        row.push(cell)
      } else {
        return null
      }
    }
    rows.push(row)
  }
  if (typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt) || d.createdAt < 0) {
    return null
  }
  return { id: d.id, name: d.name, columns, rows, createdAt: d.createdAt }
}
