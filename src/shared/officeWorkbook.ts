import type { CellObject, WorkBook, WorkSheet } from 'xlsx'
import type { FileGrant } from './types'

/**
 * Office workbook snapshot model shared between Main (SheetJS parse/write)
 * and the renderer (Univer editor). The shape is a deliberately small subset
 * of Univer's `IWorkbookData` (see @univerjs/core sheets/typedef.d.ts), so the
 * renderer can hand it to `univerAPI.createWorkbook` with a plain cast and
 * Main can rebuild a SheetJS WorkBook from it — while staying fully
 * JSON-serializable and cheap to validate at the IPC boundary.
 *
 * Fidelity boundary (documented behavior, not a bug):
 * - Sheet names, order, visibility, raw cell values (number / string /
 *   boolean; dates become their formatted text) and basic merge ranges
 *   round-trip.
 * - Formulas and their computed values are retained for ordinary cells.
 * - Common cell styles, row/column sizes, merges and hidden sheets are
 *   retained. Charts, images, macros, external links and other complex
 *   features are intentionally outside this editor's fidelity boundary.
 */

/** Mirrors Univer's CellValueType enum (numeric: STRING=1, NUMBER=2, BOOLEAN=3, FORCE_STRING=4). */
export type OfficeCellValueType = 1 | 2 | 3 | 4

export interface OfficeCellStyle {
  bold?: boolean
  italic?: boolean
  fontSize?: number
  fontColor?: string
  fillColor?: string
  horizontalAlign?: 'left' | 'center' | 'right' | 'justify'
  numberFormat?: string
}

export interface OfficeCellData {
  v?: string | number | boolean
  t?: OfficeCellValueType
  /** Formula without a leading '='; the displayed/computed value stays in v. */
  f?: string
  /** SheetJS display text, when it differs from the raw value. */
  w?: string
  style?: OfficeCellStyle
}

export interface OfficeDimensionData {
  size?: number
  hidden?: boolean
}

/** Basic merge range, a subset of Univer's IRange. */
export interface OfficeMergeRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export interface OfficeSheetSnapshot {
  id: string
  name: string
  /** 0 visible, 1 hidden (Univer BooleanNumber). */
  hidden: 0 | 1
  rowCount: number
  columnCount: number
  /** Sparse object matrix: cellData[row][col], keys are 0-based indexes. */
  cellData: { [row: number]: { [col: number]: OfficeCellData } }
  mergeData: OfficeMergeRange[]
  columnData?: { [column: number]: OfficeDimensionData }
  rowData?: { [row: number]: OfficeDimensionData }
}

export interface OfficeWorkbookSnapshot {
  id: string
  name: string
  sheetOrder: string[]
  sheets: { [sheetId: string]: OfficeSheetSnapshot }
}

export const OFFICE_WORKBOOK_LIMITS = {
  maxSheets: 200,
  maxRows: 20_000,
  maxColumns: 200,
  maxCellsPerSheet: 100_000,
  maxCellTextLength: 32_767,
  maxSheetNameLength: 100
} as const

/** Stable warning codes produced by import/sanitize truncation paths. */
export type OfficeWorkbookWarning =
  | 'too-many-sheets'
  | 'too-many-rows'
  | 'too-many-columns'
  | 'too-many-cells'
  | 'cell-text-truncated'
  | 'merge-dropped'
  | 'formula-truncated'
  | 'style-dropped'

export interface OfficeWorkbookConversion {
  snapshot: OfficeWorkbookSnapshot
  warnings: OfficeWorkbookWarning[]
}

// ---------------------------------------------------------------------------
// IPC-facing result types (the raw file path never crosses preload).
// ---------------------------------------------------------------------------

/** A native open dialog produced one read grant, or null when cancelled. */
export interface OfficeOpenDialogResult {
  grant: FileGrant
  /** Display-only basename. */
  name: string
}

export type OfficeReadError = 'invalid-grant' | 'invalid-path' | 'file-too-large' | 'read-failed' | 'parse-failed'

export type OfficeReadResult =
  | { ok: true; name: string; snapshot: OfficeWorkbookSnapshot; warnings: OfficeWorkbookWarning[] }
  | { ok: false; error: OfficeReadError; detail?: string }

/** A native save dialog produced one write grant, or null when cancelled. */
export interface OfficeSaveDialogResult {
  grant: FileGrant
  /** Display-only basename of the chosen target. */
  name: string
}

export type OfficeSaveError = 'invalid-grant' | 'invalid-snapshot' | 'snapshot-too-large' | 'write-failed'

export type OfficeSaveResult = { ok: true } | { ok: false; error: OfficeSaveError; detail?: string }

// ---------------------------------------------------------------------------
// Minimal A1-reference helpers (kept local so this module stays runtime-free
// of SheetJS — only its types are imported, which are erased at compile time).
// ---------------------------------------------------------------------------

const CELL_REF_RE = /^([A-Za-z]{1,3})(\d{1,7})$/

function columnLabelToIndex(label: string): number {
  let index = 0
  for (const ch of label.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return index - 1
}

function indexToColumnLabel(index: number): string {
  let label = ''
  let i = index + 1
  while (i > 0) {
    const rem = (i - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    i = Math.floor((i - 1) / 26)
  }
  return label
}

/** Parse 'A1' or 'A1:C3' (a '$' prefix and sheet-qualified refs are tolerated). */
function parseRangeRef(ref: string): { sR: number; sC: number; eR: number; eC: number } | null {
  const bare = ref.includes('!') ? ref.slice(ref.lastIndexOf('!') + 1) : ref
  const [start, end] = bare.replace(/\$/g, '').split(':')
  const sm = CELL_REF_RE.exec(start ?? '')
  const em = CELL_REF_RE.exec(end ?? start ?? '')
  if (!sm || !em) return null
  return {
    sR: Number(sm[2]) - 1,
    sC: columnLabelToIndex(sm[1]),
    eR: Number(em[2]) - 1,
    eC: columnLabelToIndex(em[1])
  }
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

/** Excel worksheet-name characters that SheetJS/Excel reject. */
const SHEET_NAME_FORBIDDEN_RE = /[\\/?*[\]:]/g
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g

function sanitizeSheetName(raw: unknown, used: Set<string>): string {
  const base =
    typeof raw === 'string'
      ? raw.replace(CONTROL_CHARS_RE, '').replace(SHEET_NAME_FORBIDDEN_RE, '_').trim()
      : ''
  let name = (base || 'Sheet').slice(0, 31)
  let suffix = 2
  while (used.has(name)) {
    const tail = `_${suffix++}`
    name = `${(base || 'Sheet').slice(0, 31 - tail.length)}${tail}`
  }
  used.add(name)
  return name
}

function truncateCellText(value: string, warnings: Set<OfficeWorkbookWarning>): string {
  if (value.length <= OFFICE_WORKBOOK_LIMITS.maxCellTextLength) return value
  warnings.add('cell-text-truncated')
  return value.slice(0, OFFICE_WORKBOOK_LIMITS.maxCellTextLength)
}

const MAX_FORMULA_LENGTH = 8_192

function formulaText(value: unknown, warnings: Set<OfficeWorkbookWarning>): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const normalized = value.startsWith('=') ? value.slice(1) : value
  if (normalized.length <= MAX_FORMULA_LENGTH) return normalized
  warnings.add('formula-truncated')
  return normalized.slice(0, MAX_FORMULA_LENGTH)
}

function colorText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length <= 32) return value.startsWith('#') ? value : `#${value}`
  if (!value || typeof value !== 'object') return undefined
  const color = value as Record<string, unknown>
  const rgb = typeof color.rgb === 'string' ? color.rgb : typeof color.argb === 'string' ? color.argb : undefined
  if (!rgb || rgb.length > 32) return undefined
  return rgb.startsWith('#') ? rgb : `#${rgb.slice(-6)}`
}

function sheetJsStyle(cell: CellObject, warnings: Set<OfficeWorkbookWarning>): OfficeCellStyle | undefined {
  const raw = (cell as CellObject & { s?: unknown }).s
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const font = source.font && typeof source.font === 'object' ? source.font as Record<string, unknown> : {}
  const fill = source.fill && typeof source.fill === 'object' ? source.fill as Record<string, unknown> : {}
  const alignment = source.alignment && typeof source.alignment === 'object' ? source.alignment as Record<string, unknown> : {}
  const horizontal = alignment.horizontal
  const style: OfficeCellStyle = {
    ...(font.bold === true ? { bold: true } : {}),
    ...(font.italic === true ? { italic: true } : {}),
    ...(typeof font.sz === 'number' && Number.isFinite(font.sz) ? { fontSize: Math.min(Math.max(font.sz, 6), 96) } : {}),
    ...(colorText(font.color) ? { fontColor: colorText(font.color) } : {}),
    ...(colorText(fill.fgColor) ? { fillColor: colorText(fill.fgColor) } : {}),
    ...(horizontal === 'left' || horizontal === 'center' || horizontal === 'right' || horizontal === 'justify'
      ? { horizontalAlign: horizontal }
      : {}),
    ...((typeof (cell as CellObject & { z?: unknown }).z === 'string' && (cell as CellObject & { z?: string }).z && (cell as CellObject & { z: string }).z !== 'General')
      ? { numberFormat: (cell as CellObject & { z: string }).z.slice(0, 128) }
      : {})
  }
  if (Object.keys(style).length === 0) {
    warnings.add('style-dropped')
    return undefined
  }
  return style
}

function cellExtras(cell: CellObject, warnings: Set<OfficeWorkbookWarning>): Pick<OfficeCellData, 'f' | 'w' | 'style'> {
  const f = formulaText((cell as CellObject & { f?: unknown }).f, warnings)
  const display = (cell as CellObject & { w?: unknown }).w
  const w = typeof display === 'string' && display && display !== String((cell as { v?: unknown }).v ?? '')
    ? truncateCellText(display, warnings)
    : undefined
  const style = sheetJsStyle(cell, warnings)
  return { ...(f ? { f } : {}), ...(w ? { w } : {}), ...(style ? { style } : {}) }
}

// ---------------------------------------------------------------------------
// SheetJS → snapshot (Main, on file open)
// ---------------------------------------------------------------------------

/** Map one SheetJS cell to the snapshot cell; null when the cell carries no value. */
function sheetJsCell(cell: CellObject, warnings: Set<OfficeWorkbookWarning>): OfficeCellData | null {
  const v = (cell as { v?: unknown }).v
  const extras = cellExtras(cell, warnings)
  const withExtras = (data: OfficeCellData): OfficeCellData => ({ ...data, ...extras })
  switch (cell.t) {
    case 'n':
      if (typeof v === 'number' && Number.isFinite(v)) return withExtras({ v, t: 2 })
      if (v === undefined || v === null) return null
      return withExtras({ v: truncateCellText(String(v), warnings), t: 1 })
    case 's':
      if (v === undefined || v === null) return null
      return withExtras({ v: truncateCellText(String(v), warnings), t: 1 })
    case 'b':
      if (typeof v === 'boolean') return withExtras({ v, t: 3 })
      if (v === undefined || v === null) return null
      return withExtras({ v: Boolean(v), t: 3 })
    case 'd': {
      // Dates are stored as their formatted text (cell.w) or ISO fallback.
      const w = (cell as { w?: unknown }).w
      if (typeof w === 'string' && w) return withExtras({ v: truncateCellText(w, warnings), t: 1 })
      if (isDate(v)) return withExtras({ v: v.toISOString(), t: 1 })
      if (v === undefined || v === null) return null
      return withExtras({ v: truncateCellText(String(v), warnings), t: 1 })
    }
    case 'e': {
      const w = (cell as { w?: unknown }).w
      const text = typeof w === 'string' && w ? w : String(v ?? '')
      if (!text) return null
      return withExtras({ v: truncateCellText(text, warnings), t: 1 })
    }
    default:
      // 'z' (stub/blank) and unknown types: a formula cell keeps only its
      // computed value; anything without a value is dropped.
      if (typeof v === 'number' && Number.isFinite(v)) return withExtras({ v, t: 2 })
      if (typeof v === 'boolean') return withExtras({ v, t: 3 })
      if (typeof v === 'string' && v) return withExtras({ v: truncateCellText(v, warnings), t: 1 })
      if (isDate(v)) return withExtras({ v: v.toISOString(), t: 1 })
      return null
  }
}

/**
 * Convert a SheetJS WorkBook into the bounded snapshot. Sheets, rows, columns
 * and cell text beyond OFFICE_WORKBOOK_LIMITS are truncated with warnings.
 */
export function sheetJsToUniver(wb: WorkBook): OfficeWorkbookConversion {
  const warnings = new Set<OfficeWorkbookWarning>()
  const sheetOrder: string[] = []
  const sheets: { [sheetId: string]: OfficeSheetSnapshot } = {}
  const names = wb.SheetNames.slice(0, OFFICE_WORKBOOK_LIMITS.maxSheets)
  if (wb.SheetNames.length > OFFICE_WORKBOOK_LIMITS.maxSheets) warnings.add('too-many-sheets')
  const visibility = wb.Workbook?.Sheets

  names.forEach((rawName, index) => {
    const ws = wb.Sheets[rawName]
    const id = `sheet-${index}`
    const name = typeof rawName === 'string' && rawName ? rawName.slice(0, OFFICE_WORKBOOK_LIMITS.maxSheetNameLength) : `Sheet${index + 1}`
    const cellData: { [row: number]: { [col: number]: OfficeCellData } } = {}
    let maxRow = -1
    let maxCol = -1
    let cellCount = 0
    let rowsClipped = false
    let colsClipped = false
    let cellsClipped = false
    const columnData: { [column: number]: OfficeDimensionData } = {}
    const rowData: { [row: number]: OfficeDimensionData } = {}

    if (ws) {
      const columns = ws['!cols']
      if (Array.isArray(columns)) {
        columns.slice(0, OFFICE_WORKBOOK_LIMITS.maxColumns).forEach((column, columnIndex) => {
          if (!column || typeof column !== 'object') return
          const value = column as { wpx?: unknown; wch?: unknown; width?: unknown; hidden?: unknown }
          const rawSize = typeof value.wpx === 'number' ? value.wpx : typeof value.wch === 'number' ? value.wch * 7 : value.width
          const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 20), 600) : undefined
          if (size !== undefined || value.hidden === true) columnData[columnIndex] = { ...(size !== undefined ? { size } : {}), ...(value.hidden === true ? { hidden: true } : {}) }
        })
      }
      const rows = ws['!rows']
      if (Array.isArray(rows)) {
        rows.slice(0, OFFICE_WORKBOOK_LIMITS.maxRows).forEach((row, rowIndex) => {
          if (!row || typeof row !== 'object') return
          const value = row as { hpx?: unknown; hpt?: unknown; height?: unknown; hidden?: unknown }
          const rawSize = typeof value.hpx === 'number' ? value.hpx : typeof value.hpt === 'number' ? value.hpt * (96 / 72) : value.height
          const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 12), 240) : undefined
          if (size !== undefined || value.hidden === true) rowData[rowIndex] = { ...(size !== undefined ? { size } : {}), ...(value.hidden === true ? { hidden: true } : {}) }
        })
      }
      for (const key of Object.keys(ws)) {
        if (key.startsWith('!')) continue
        const m = CELL_REF_RE.exec(key)
        if (!m) continue
        const row = Number(m[2]) - 1
        const col = columnLabelToIndex(m[1])
        if (row >= OFFICE_WORKBOOK_LIMITS.maxRows) {
          rowsClipped = true
          continue
        }
        if (col >= OFFICE_WORKBOOK_LIMITS.maxColumns) {
          colsClipped = true
          continue
        }
        if (cellCount >= OFFICE_WORKBOOK_LIMITS.maxCellsPerSheet) {
          cellsClipped = true
          continue
        }
        const cell = sheetJsCell(ws[key] as CellObject, warnings)
        if (!cell) continue
        ;(cellData[row] ??= {})[col] = cell
        cellCount += 1
        if (row > maxRow) maxRow = row
        if (col > maxCol) maxCol = col
      }
    }
    if (rowsClipped) warnings.add('too-many-rows')
    if (colsClipped) warnings.add('too-many-columns')
    if (cellsClipped) warnings.add('too-many-cells')

    // Declared range widens the grid beyond the sparse cells; clamp it.
    const declared = typeof ws?.['!ref'] === 'string' ? parseRangeRef(ws['!ref']) : null
    if (declared) {
      if (declared.eR > maxRow) maxRow = Math.min(declared.eR, OFFICE_WORKBOOK_LIMITS.maxRows - 1)
      if (declared.eC > maxCol) maxCol = Math.min(declared.eC, OFFICE_WORKBOOK_LIMITS.maxColumns - 1)
    }

    const mergeData: OfficeMergeRange[] = []
    const merges = ws?.['!merges']
    if (Array.isArray(merges)) {
      for (const merge of merges) {
        const sR = merge?.s?.r
        const sC = merge?.s?.c
        const eR = merge?.e?.r
        const eC = merge?.e?.c
        if (
          typeof sR !== 'number' ||
          typeof sC !== 'number' ||
          typeof eR !== 'number' ||
          typeof eC !== 'number' ||
          sR < 0 ||
          sC < 0 ||
          eR >= OFFICE_WORKBOOK_LIMITS.maxRows ||
          eC >= OFFICE_WORKBOOK_LIMITS.maxColumns
        ) {
          warnings.add('merge-dropped')
          continue
        }
        mergeData.push({
          startRow: Math.min(sR, eR),
          startColumn: Math.min(sC, eC),
          endRow: Math.max(sR, eR),
          endColumn: Math.max(sC, eC)
        })
        if (Math.max(sR, eR) > maxRow) maxRow = Math.max(sR, eR)
        if (Math.max(sC, eC) > maxCol) maxCol = Math.max(sC, eC)
      }
    }

    sheetOrder.push(id)
    sheets[id] = {
      id,
      name,
      hidden: visibility && visibility[index]?.Hidden ? 1 : 0,
      // Univer shows exactly rowCount × columnCount; keep a usable minimum.
      rowCount: Math.max(Math.min(maxRow + 1, OFFICE_WORKBOOK_LIMITS.maxRows), 1000),
      columnCount: Math.max(Math.min(maxCol + 1, OFFICE_WORKBOOK_LIMITS.maxColumns), 26),
      cellData,
      mergeData,
      ...(Object.keys(columnData).length > 0 ? { columnData } : {}),
      ...(Object.keys(rowData).length > 0 ? { rowData } : {})
    }
  })

  // An empty/structureless workbook still opens as one blank sheet.
  if (sheetOrder.length === 0) {
    sheetOrder.push('sheet-0')
    sheets['sheet-0'] = {
      id: 'sheet-0',
      name: 'Sheet1',
      hidden: 0,
      rowCount: 1000,
      columnCount: 26,
      cellData: {},
      mergeData: [],
      columnData: {},
      rowData: {}
    }
  }

  return { snapshot: { id: 'workbook', name: '', sheetOrder, sheets }, warnings: [...warnings] }
}

// ---------------------------------------------------------------------------
// Snapshot → SheetJS (Main, on save-as)
// ---------------------------------------------------------------------------

/** Rebuild a SheetJS WorkBook from a sanitized snapshot. */
export function univerToSheetJs(snapshot: OfficeWorkbookSnapshot): WorkBook {
  const wb: WorkBook = {
    SheetNames: [],
    Sheets: {},
    Workbook: { Sheets: [] }
  }
  const usedNames = new Set<string>()

  for (const sheetId of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetId]
    if (!sheet) continue
    const name = sanitizeSheetName(sheet.name, usedNames)
    const ws: WorkSheet = {}
    let maxRow = -1
    let maxCol = -1

    for (const [rowKey, row] of Object.entries(sheet.cellData)) {
      const r = Number(rowKey)
      if (!Number.isInteger(r) || r < 0) continue
      for (const [colKey, cell] of Object.entries(row)) {
        const c = Number(colKey)
        if (!Number.isInteger(c) || c < 0 || !cell) continue
        const v = cell.v
        if (v === undefined || v === null) continue
        const ref = `${indexToColumnLabel(c)}${r + 1}`
        const formula = typeof cell.f === 'string' && cell.f ? cell.f.replace(/^=/, '') : undefined
        const style = cell.style ? {
          font: {
            ...(cell.style.bold ? { bold: true } : {}),
            ...(cell.style.italic ? { italic: true } : {}),
            ...(cell.style.fontSize ? { sz: cell.style.fontSize } : {}),
            ...(cell.style.fontColor ? { color: { rgb: cell.style.fontColor.replace(/^#/, '') } } : {})
          },
          ...(cell.style.fillColor ? { fill: { fgColor: { rgb: cell.style.fillColor.replace(/^#/, '') } } } : {}),
          ...(cell.style.horizontalAlign ? { alignment: { horizontal: cell.style.horizontalAlign } } : {}),
          ...(cell.style.numberFormat ? { z: cell.style.numberFormat } : {})
        } : undefined
        const extras = { ...(formula ? { f: formula } : {}), ...(cell.w ? { w: cell.w } : {}), ...(style ? { s: style } : {}) }
        if (cell.t === 2 || (cell.t === undefined && typeof v === 'number')) {
          ws[ref] = typeof v === 'number' && Number.isFinite(v) ? { t: 'n', v, ...extras } : { t: 's', v: String(v), ...extras }
        } else if (cell.t === 3 || (cell.t === undefined && typeof v === 'boolean')) {
          ws[ref] = { t: 'b', v: Boolean(v), ...extras }
        } else {
          // STRING / FORCE_STRING (and anything else) write as plain text.
          ws[ref] = { t: 's', v: String(v), ...extras }
        }
        if (r > maxRow) maxRow = r
        if (c > maxCol) maxCol = c
      }
    }

    ws['!ref'] = maxRow >= 0 ? `A1:${indexToColumnLabel(Math.max(maxCol, 0))}${maxRow + 1}` : 'A1'
    const merges = sheet.mergeData
      .filter(
        (m) =>
          Number.isInteger(m.startRow) &&
          Number.isInteger(m.startColumn) &&
          Number.isInteger(m.endRow) &&
          Number.isInteger(m.endColumn) &&
          m.startRow >= 0 &&
          m.startColumn >= 0
      )
      .map((m) => ({
        s: { r: Math.min(m.startRow, m.endRow), c: Math.min(m.startColumn, m.endColumn) },
        e: { r: Math.max(m.startRow, m.endRow), c: Math.max(m.startColumn, m.endColumn) }
      }))
    if (merges.length > 0) ws['!merges'] = merges
    const columnData = sheet.columnData
    if (columnData && Object.keys(columnData).length > 0) {
      ws['!cols'] = Object.entries(columnData).map(([key, value]) => {
        const column = Number(key)
        return {
          ...(Number.isFinite(column) && value.size !== undefined ? { wpx: value.size } : {}),
          ...(value.hidden ? { hidden: true } : {})
        }
      })
    }
    const rowData = sheet.rowData
    if (rowData && Object.keys(rowData).length > 0) {
      ws['!rows'] = Object.entries(rowData).map(([, value]) => ({
        ...(value.size !== undefined ? { hpx: value.size } : {}),
        ...(value.hidden ? { hidden: true } : {})
      }))
    }

    wb.SheetNames.push(name)
    wb.Sheets[name] = ws
    wb.Workbook!.Sheets!.push({ Hidden: sheet.hidden ? 1 : 0 })
  }

  if (wb.SheetNames.length === 0) {
    const ws: WorkSheet = { '!ref': 'A1' }
    wb.SheetNames.push('Sheet1')
    wb.Sheets.Sheet1 = ws
    wb.Workbook!.Sheets!.push({ Hidden: 0 })
  }

  return wb
}

// ---------------------------------------------------------------------------
// Renderer → Main sanitize (save path): a raw Univer `fWorkbook.save()` is
// untrusted IPC input. Keep only the snapshot subset, bound everything.
// ---------------------------------------------------------------------------

function boundedInt(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.floor(value)
  return n >= 0 && n <= max ? n : null
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_CHARS_RE, '').slice(0, max)
}

/**
 * Extract the supported snapshot subset from arbitrary data (typically a raw
 * Univer workbook snapshot arriving over IPC). Returns null when nothing
 * resembling a workbook with at least one sheet is present.
 */
export function sanitizeOfficeSnapshot(raw: unknown): OfficeWorkbookConversion | null {
  if (!raw || typeof raw !== 'object') return null
  const wb = raw as Record<string, unknown>
  const rawSheets = wb.sheets
  if (!rawSheets || typeof rawSheets !== 'object' || Array.isArray(rawSheets)) return null

  const warnings = new Set<OfficeWorkbookWarning>()
  const rawOrder = Array.isArray(wb.sheetOrder) ? wb.sheetOrder : []
  const orderedIds: string[] = []
  for (const id of rawOrder) {
    if (typeof id === 'string' && id && !orderedIds.includes(id)) orderedIds.push(id.slice(0, 128))
  }
  for (const id of Object.keys(rawSheets)) {
    if (!orderedIds.includes(id)) orderedIds.push(id)
  }

  const sheetOrder: string[] = []
  const sheets: { [sheetId: string]: OfficeSheetSnapshot } = {}

  for (const sheetId of orderedIds.slice(0, OFFICE_WORKBOOK_LIMITS.maxSheets)) {
    const rawSheet = (rawSheets as Record<string, unknown>)[sheetId]
    if (!rawSheet || typeof rawSheet !== 'object') continue
    const rs = rawSheet as Record<string, unknown>
    const id = sheetId
    const name = boundedText(rs.name, OFFICE_WORKBOOK_LIMITS.maxSheetNameLength) || 'Sheet'
    const hidden = rs.hidden === 1 || rs.hidden === 2 ? 1 : 0
    const rowCount = boundedInt(rs.rowCount, OFFICE_WORKBOOK_LIMITS.maxRows) ?? 1000
    const columnCount = boundedInt(rs.columnCount, OFFICE_WORKBOOK_LIMITS.maxColumns) ?? 26
    const columnData = sanitizeDimensionMap(rs.columnData, OFFICE_WORKBOOK_LIMITS.maxColumns, 20, 600)
    const rowData = sanitizeDimensionMap(rs.rowData, OFFICE_WORKBOOK_LIMITS.maxRows, 12, 240)

    const cellData: { [row: number]: { [col: number]: OfficeCellData } } = {}
    let cellCount = 0
    const rawCellData = rs.cellData
    if (rawCellData && typeof rawCellData === 'object' && !Array.isArray(rawCellData)) {
      for (const [rowKey, rowValue] of Object.entries(rawCellData)) {
        const r = boundedInt(Number(rowKey), OFFICE_WORKBOOK_LIMITS.maxRows - 1)
        if (r === null || !/^\d+$/.test(rowKey)) continue
        if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) continue
        for (const [colKey, cellValue] of Object.entries(rowValue as Record<string, unknown>)) {
          const c = boundedInt(Number(colKey), OFFICE_WORKBOOK_LIMITS.maxColumns - 1)
          if (c === null || !/^\d+$/.test(colKey)) continue
          if (cellCount >= OFFICE_WORKBOOK_LIMITS.maxCellsPerSheet) {
            warnings.add('too-many-cells')
            break
          }
          const cell = sanitizeCell(cellValue, warnings)
          if (!cell) continue
          ;(cellData[r] ??= {})[c] = cell
          cellCount += 1
        }
      }
    }

    const mergeData: OfficeMergeRange[] = []
    if (Array.isArray(rs.mergeData)) {
      for (const merge of rs.mergeData.slice(0, 10_000)) {
        if (!merge || typeof merge !== 'object') continue
        const m = merge as Record<string, unknown>
        const sR = boundedInt(m.startRow, OFFICE_WORKBOOK_LIMITS.maxRows - 1)
        const sC = boundedInt(m.startColumn, OFFICE_WORKBOOK_LIMITS.maxColumns - 1)
        const eR = boundedInt(m.endRow, OFFICE_WORKBOOK_LIMITS.maxRows - 1)
        const eC = boundedInt(m.endColumn, OFFICE_WORKBOOK_LIMITS.maxColumns - 1)
        if (sR === null || sC === null || eR === null || eC === null) {
          warnings.add('merge-dropped')
          continue
        }
        mergeData.push({
          startRow: Math.min(sR, eR),
          startColumn: Math.min(sC, eC),
          endRow: Math.max(sR, eR),
          endColumn: Math.max(sC, eC)
        })
      }
    }

    sheetOrder.push(id)
    sheets[id] = {
      id,
      name,
      hidden,
      rowCount,
      columnCount,
      cellData,
      mergeData,
      ...(Object.keys(columnData).length > 0 ? { columnData } : {}),
      ...(Object.keys(rowData).length > 0 ? { rowData } : {})
    }
  }
  if (orderedIds.length > OFFICE_WORKBOOK_LIMITS.maxSheets) warnings.add('too-many-sheets')

  if (sheetOrder.length === 0) return null

  return {
    snapshot: {
      id: boundedText(wb.id, 128) || 'workbook',
      name: boundedText(wb.name, 200),
      sheetOrder,
      sheets
    },
    warnings: [...warnings]
  }
}

function sanitizeCell(raw: unknown, warnings: Set<OfficeWorkbookWarning>): OfficeCellData | null {
  if (!raw || typeof raw !== 'object') return null
  const cell = raw as Record<string, unknown>
  let v = cell.v
  // Rich-text cells keep their text in the embedded document body.
  if ((v === undefined || v === null || v === '') && cell.p && typeof cell.p === 'object') {
    const stream = (cell.p as { body?: { dataStream?: unknown } }).body?.dataStream
    if (typeof stream === 'string' && stream) v = stream.replace(/[\r\n]+$/, '')
  }
  let t: OfficeCellValueType | undefined
  if (cell.t === 1 || cell.t === 2 || cell.t === 3 || cell.t === 4) t = cell.t
  if (v === undefined || v === null || v === '') return null
  const f = formulaText(cell.f, warnings)
  const w = typeof cell.w === 'string' && cell.w ? truncateCellText(cell.w, warnings) : undefined
  const style = sanitizeStyle(cell.style)
  const extras = {
    ...(f ? { f } : {}),
    ...(w ? { w } : {}),
    ...(style ? { style } : {})
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    return { v, t: t ?? 2, ...extras }
  }
  if (typeof v === 'boolean') return { v, t: t ?? 3, ...extras }
  if (typeof v === 'string') {
    // Strings beginning with '=' are forced to text unless an explicit
    // formula field was supplied by the trusted file conversion. This keeps
    // agent-provided values from becoming executable spreadsheet formulas.
    const type = f ? (t === 2 || t === 3 ? 1 : t ?? 1) : v.startsWith('=') ? 4 : (t === 2 || t === 3 ? 1 : t ?? 1)
    return { v: truncateCellText(v, warnings), t: type, ...extras }
  }
  return null
}

function sanitizeStyle(raw: unknown): OfficeCellStyle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const horizontal = value.horizontalAlign
  const style: OfficeCellStyle = {
    ...(value.bold === true ? { bold: true } : {}),
    ...(value.italic === true ? { italic: true } : {}),
    ...(typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)
      ? { fontSize: Math.min(Math.max(Math.floor(value.fontSize), 6), 96) }
      : {}),
    ...(typeof value.fontColor === 'string' && /^#[0-9a-f]{6,8}$/i.test(value.fontColor) ? { fontColor: value.fontColor } : {}),
    ...(typeof value.fillColor === 'string' && /^#[0-9a-f]{6,8}$/i.test(value.fillColor) ? { fillColor: value.fillColor } : {}),
    ...(horizontal === 'left' || horizontal === 'center' || horizontal === 'right' || horizontal === 'justify'
      ? { horizontalAlign: horizontal }
      : {}),
    ...(typeof value.numberFormat === 'string' && value.numberFormat.length <= 128
      ? { numberFormat: value.numberFormat }
      : {})
  }
  return Object.keys(style).length > 0 ? style : undefined
}

function sanitizeDimensionMap(
  raw: unknown,
  max: number,
  minSize: number,
  maxSize: number
): { [index: number]: OfficeDimensionData } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: { [index: number]: OfficeDimensionData } = {}
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= max || !item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const rawSize = value.size ?? value.w ?? value.h
    const size = typeof rawSize === 'number' && Number.isFinite(rawSize)
      ? Math.min(Math.max(Math.round(rawSize), minSize), maxSize)
      : undefined
    const hidden = value.hidden === true || value.hd === 1
    if (size !== undefined || hidden) result[index] = { ...(size !== undefined ? { size } : {}), ...(hidden ? { hidden: true } : {}) }
  }
  return result
}
