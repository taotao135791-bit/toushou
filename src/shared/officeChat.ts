import { Language } from './types'

/**
 * A bounded, reviewable snapshot used when a user asks the chat agent about
 * the workbook open in the Office panel. It intentionally includes only the
 * workbook name, sheet names, used-range sizes and a short header-row sample
 * per sheet — never full data rows. The result is a composer draft, never an
 * auto-sent prompt, so the user can edit it before it leaves the app.
 *
 * The input is a raw Univer workbook snapshot (FWorkbook.save()); only the
 * small subset also used by officeWorkbook.ts is read, so a sanitized
 * OfficeWorkbookSnapshot works as well.
 */

const MAX_SHEETS = 50
const MAX_HEADER_CELLS = 12
const MAX_CELL_TEXT = 40
const MAX_TEXT = 12_000

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`
}

/** Display text of one raw Univer cell ('' when the cell carries no value). */
function cellText(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return ''
  const v = (cell as { v?: unknown }).v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string' && v) return v
  // Rich-text cells keep their text in the embedded document body.
  const stream = (cell as { p?: { body?: { dataStream?: unknown } } }).p?.body?.dataStream
  return typeof stream === 'string' ? stream : ''
}

function sheetEntries(raw: unknown): [string, Record<string, unknown>][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw).filter(
    (entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === 'object'
  )
}

function rowEntries(raw: unknown): [number, Record<string, unknown>][] {
  return sheetEntries(raw)
    .map(([key, value]) => [Number(key), value] as [number, Record<string, unknown>])
    .filter(([row]) => Number.isInteger(row) && row >= 0)
    .sort((a, b) => a[0] - b[0])
}

interface SheetSummary {
  name: string
  hidden: boolean
  usedRows: number
  usedCols: number
  header: string[]
}

function summarizeSheet(id: string, sheet: Record<string, unknown>): SheetSummary {
  const name = typeof sheet.name === 'string' && sheet.name.trim() ? sheet.name.trim() : id
  let maxRow = -1
  let maxCol = -1
  let header: string[] = []
  for (const [rowIndex, row] of rowEntries(sheet.cellData)) {
    const cells = rowEntries(row).map(([colIndex, cell]) => ({ colIndex, text: cellText(cell) }))
    for (const { colIndex, text } of cells) {
      if (text === '') continue
      if (rowIndex > maxRow) maxRow = rowIndex
      if (colIndex > maxCol) maxCol = colIndex
    }
    if (header.length === 0) {
      const sample = cells.map((cell) => cell.text).filter(Boolean)
      if (sample.length > 0) header = sample.slice(0, MAX_HEADER_CELLS).map((text) => compact(text, MAX_CELL_TEXT))
    }
  }
  return {
    name,
    hidden: sheet.hidden === 1,
    usedRows: maxRow + 1,
    usedCols: maxCol + 1,
    header
  }
}

/** True when any sheet of the raw workbook snapshot holds at least one value. */
export function snapshotHasData(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  for (const [, sheet] of sheetEntries((raw as { sheets?: unknown }).sheets)) {
    for (const [, row] of sheetEntries(sheet.cellData)) {
      for (const cell of Object.values(row)) {
        if (cellText(cell) !== '') return true
      }
    }
  }
  return false
}

/**
 * Build the composer draft for "ask agent about this workbook". Returns null
 * when the raw snapshot holds no workbook sheets at all.
 */
export function buildOfficeChatPrompt(
  raw: unknown,
  options: { name?: string; language?: Language } = {}
): string | null {
  if (!raw || typeof raw !== 'object') return null
  const wb = raw as Record<string, unknown>
  const sheets = sheetEntries(wb.sheets)
  if (sheets.length === 0) return null
  const rawOrder = Array.isArray(wb.sheetOrder) ? wb.sheetOrder.filter((id) => typeof id === 'string') : []
  const ordered = [
    ...rawOrder
      .map((id) => sheets.find(([sheetId]) => sheetId === id))
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry)),
    ...sheets.filter(([id]) => !rawOrder.includes(id))
  ]
  if (ordered.length === 0) return null

  const isChinese = options.language === 'zh'
  const name = options.name?.trim() || (typeof wb.name === 'string' ? wb.name.trim() : '')
  const summaries = ordered.slice(0, MAX_SHEETS).map(([id, sheet]) => summarizeSheet(id, sheet))
  const omitted = ordered.length - summaries.length

  const sheetLines = summaries.map((sheet) => {
    const size =
      sheet.usedRows > 0
        ? isChinese
          ? `${sheet.usedRows} 行 x ${sheet.usedCols} 列`
          : `${sheet.usedRows} rows x ${sheet.usedCols} cols`
        : isChinese
          ? '空表'
          : 'empty'
    const header =
      sheet.header.length > 0
        ? isChinese
          ? `；表头：${sheet.header.join(', ')}`
          : `; headers: ${sheet.header.join(', ')}`
        : ''
    const hidden = sheet.hidden ? (isChinese ? '（隐藏）' : ' (hidden)') : ''
    return `- ${compact(sheet.name, 100)}${hidden}: ${size}${header}`
  })

  const content = isChinese
    ? [
        '请基于下面的本地工作簿摘要帮助我分析。它只是只读上下文：仅包含结构和表头样例，不含数据行；不要声称你已经修改了工作簿；如建议改动，请列出我可以自己执行的具体步骤。',
        '',
        `工作簿：${compact(name, 200) || '（未命名）'}`,
        `工作表（${ordered.length} 个）：`,
        ...sheetLines,
        omitted > 0 ? `- 其余 ${omitted} 个工作表未列出` : '',
        '',
        '请先说明你观察到的重点、风险或缺口，再给出下一步建议。'
      ]
    : [
        'Help me analyze this local workbook. Treat it as read-only context: only structure and header samples are included, no data rows. Do not claim that you edited the workbook; if you suggest changes, list concrete steps I can apply myself.',
        '',
        `Workbook: ${compact(name, 200) || '(untitled)'}`,
        `Sheets (${ordered.length}):`,
        ...sheetLines,
        omitted > 0 ? `- ${omitted} more sheets omitted` : '',
        '',
        'First identify the key observations, risks, or gaps, then suggest the next steps.'
      ]
  return content.filter(Boolean).join('\n').slice(0, MAX_TEXT)
}
