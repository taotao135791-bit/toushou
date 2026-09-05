import { OfficeEditCell, OfficeEditIssue, OfficeEditParseResult, OfficeEditProposal } from './types'

/**
 * Office edit proposal (```office-edit fences) — the workbook sibling of the
 * board-cards protocol. The agent PROPOSES a bounded list of cell edits for
 * the workbook open in the Office panel; the chat UI renders them as a
 * preview card, and only an explicit user confirmation applies them to the
 * renderer's in-memory Univer instance. The agent can never write a
 * workbook: application happens in the renderer AFTER the person confirms,
 * and persistence still flows exclusively through the user's own
 * open/save-as FileGrants — a proposal that is never applied leaves no
 * trace anywhere.
 *
 * The parser mirrors boardCards.ts: pure, strict about the envelope
 * (version, edit count) and lenient per edit — an invalid edit is skipped
 * with a warning so one malformed entry cannot hide the rest, while a
 * proposal whose edits are ALL invalid fails to parse. Unknown fields are
 * dropped silently; every kept value is bounded. Values accept only plain
 * string/number/boolean scalars, and a string starting with "=" is rejected
 * outright: Univer interprets a leading "=" as a formula, so this is the
 * formula-injection guard for the sheet.
 */

/** Fence language the chat UI renders as an apply-able cell-edit proposal. */
export const OFFICE_EDIT_FENCE = 'office-edit'

export const OFFICE_EDIT_LIMITS = {
  /** Raw fence text cap. Sized to hold maxEdits edits at the max string
   * length (200 × ~1.2 KB ≈ 240 KB) with JSON overhead to spare. */
  maxBytes: 256 * 1024,
  /** Schema version; anything else is a hard error. */
  version: 1,
  maxEdits: 200,
  maxSheetLength: 60,
  maxStringLength: 1000,
  maxNoteLength: 500
} as const

/** A1-style cell reference: 1-3 letters, then a row that never starts with 0. */
const CELL_PATTERN = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/

function issue(level: 'error' | 'warning', edit: number | null, message: string): OfficeEditIssue {
  return { level, edit, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate one proposed edit. Returns the cleaned edit, or null when the
 * edit must be skipped (a warning is recorded by the caller in either case).
 */
function parseEdit(raw: unknown, index: number, issues: OfficeEditIssue[]): OfficeEditCell | null {
  if (!isPlainObject(raw)) {
    issues.push(issue('warning', index, 'Edit is not an object; skipped.'))
    return null
  }
  const sheet = typeof raw.sheet === 'string' ? raw.sheet.trim() : ''
  if (!sheet) {
    issues.push(issue('warning', index, 'Edit has no "sheet" name; skipped.'))
    return null
  }
  if (sheet.length > OFFICE_EDIT_LIMITS.maxSheetLength) {
    issues.push(
      issue('warning', index, `Edit "sheet" exceeds ${OFFICE_EDIT_LIMITS.maxSheetLength} characters; skipped.`)
    )
    return null
  }
  const cell = typeof raw.cell === 'string' ? raw.cell.trim() : ''
  if (!CELL_PATTERN.test(cell)) {
    issues.push(issue('warning', index, 'Edit needs an A1-style "cell" (e.g. "B2"); skipped.'))
    return null
  }
  if (typeof raw.value === 'string') {
    const value = raw.value.trim()
    if (value.startsWith('=')) {
      // Univer treats a leading "=" as a formula. Proposals never carry
      // formulas — reject the edit outright rather than escaping it.
      issues.push(issue('warning', index, 'Edit value looks like a formula ("=…"); formulas are not allowed; skipped.'))
      return null
    }
    if (value.length > OFFICE_EDIT_LIMITS.maxStringLength) {
      issues.push(
        issue('warning', index, `Edit value exceeds ${OFFICE_EDIT_LIMITS.maxStringLength} characters; skipped.`)
      )
      return null
    }
    return { sheet, cell, value }
  }
  if (isFiniteNumber(raw.value)) {
    return { sheet, cell, value: raw.value }
  }
  if (typeof raw.value === 'boolean') {
    return { sheet, cell, value: raw.value }
  }
  issues.push(issue('warning', index, 'Edit "value" must be a string, number, or boolean; skipped.'))
  return null
}

/**
 * Parse a raw ```office-edit fence body into a proposal plus per-edit issues.
 * `ok: false` means the whole document is unusable (bad JSON, wrong version,
 * no usable edits at all) and must never be applied.
 */
export function parseOfficeEditProposal(raw: string): OfficeEditParseResult {
  const issues: OfficeEditIssue[] = []
  if (typeof raw !== 'string' || !raw.trim() || raw.length > OFFICE_EDIT_LIMITS.maxBytes) {
    return { ok: false, issues: [issue('error', null, 'Proposal is empty or too large.')] }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return { ok: false, issues: [issue('error', null, 'Proposal is not valid JSON.')] }
  }
  if (!isPlainObject(document)) {
    return { ok: false, issues: [issue('error', null, 'Proposal must be a JSON object.')] }
  }
  if (document.version !== OFFICE_EDIT_LIMITS.version) {
    return {
      ok: false,
      issues: [issue('error', null, `Unsupported proposal version: ${JSON.stringify(document.version ?? null).slice(0, 30)}.`)]
    }
  }
  if (!Array.isArray(document.edits)) {
    return { ok: false, issues: [issue('error', null, 'Proposal has no "edits" array.')] }
  }
  if (document.edits.length === 0) {
    return { ok: false, issues: [issue('error', null, 'Proposal has no edits.')] }
  }
  if (document.edits.length > OFFICE_EDIT_LIMITS.maxEdits) {
    issues.push(
      issue('warning', null, `Proposal truncated to the first ${OFFICE_EDIT_LIMITS.maxEdits} edits.`)
    )
  }
  const edits: OfficeEditCell[] = []
  const limit = Math.min(document.edits.length, OFFICE_EDIT_LIMITS.maxEdits)
  for (let index = 0; index < limit; index++) {
    const edit = parseEdit(document.edits[index], index, issues)
    if (edit) edits.push(edit)
  }
  if (edits.length === 0) {
    return {
      ok: false,
      issues: [...issues, issue('error', null, 'No valid edits in this proposal.')]
    }
  }
  const proposal: OfficeEditProposal = { version: OFFICE_EDIT_LIMITS.version, edits }
  if (document.note !== undefined) {
    if (typeof document.note !== 'string' || document.note.trim().length > OFFICE_EDIT_LIMITS.maxNoteLength) {
      issues.push(issue('warning', null, `Proposal "note" ignored (must be ≤ ${OFFICE_EDIT_LIMITS.maxNoteLength} characters).`))
    } else if (document.note.trim()) {
      proposal.note = document.note.trim()
    }
  }
  return { ok: true, proposal, issues }
}

/**
 * Convert an A1-style reference (already format-validated by the parser) to
 * 0-based { row, column } indices, or null when out of the representable
 * range. Pure — the Office panel uses this for cell-bounds checks before
 * writing, so Univer never receives a reference beyond the sheet grid.
 */
export function a1ToIndices(cell: string): { row: number; column: number } | null {
  const ref = cell.trim()
  if (!CELL_PATTERN.test(ref)) return null
  const digitsStart = ref.search(/[0-9]/)
  let column = 0
  for (const char of ref.slice(0, digitsStart).toUpperCase()) {
    column = column * 26 + (char.charCodeAt(0) - 64)
    if (!Number.isSafeInteger(column)) return null
  }
  const row = Number(ref.slice(digitsStart))
  if (!Number.isSafeInteger(row) || row <= 0) return null
  return { row: row - 1, column: column - 1 }
}
