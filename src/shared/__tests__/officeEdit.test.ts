import { describe, expect, it } from 'vitest'
import { OFFICE_EDIT_LIMITS, a1ToIndices, parseOfficeEditProposal } from '../officeEdit'

const VALID = JSON.stringify({
  version: 1,
  edits: [
    { sheet: 'Sheet1', cell: 'B2', value: '新文案' },
    { sheet: 'Sheet1', cell: 'C2', value: 123 },
    { sheet: '汇总', cell: 'D10', value: true }
  ],
  note: '统一口径后的标题'
})

function parse(raw: string | unknown) {
  return parseOfficeEditProposal(typeof raw === 'string' ? raw : JSON.stringify(raw))
}

describe('parseOfficeEditProposal — valid documents', () => {
  it('parses a full valid proposal with no issues', () => {
    const result = parse(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues).toEqual([])
    expect(result.proposal.version).toBe(1)
    expect(result.proposal.edits).toEqual([
      { sheet: 'Sheet1', cell: 'B2', value: '新文案' },
      { sheet: 'Sheet1', cell: 'C2', value: 123 },
      { sheet: '汇总', cell: 'D10', value: true }
    ])
    expect(result.proposal.note).toBe('统一口径后的标题')
  })

  it('keeps note absent when omitted', () => {
    const result = parse({ version: 1, edits: [{ sheet: 'S', cell: 'A1', value: 0 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits[0]).toEqual({ sheet: 'S', cell: 'A1', value: 0 })
    expect(result.proposal.note).toBeUndefined()
  })

  it('accepts string/number/boolean values and bounds at the exact limits', () => {
    const longValue = 'v'.repeat(OFFICE_EDIT_LIMITS.maxStringLength)
    const result = parse({
      version: 1,
      edits: [
        { sheet: 'S', cell: 'A1', value: longValue },
        { sheet: 'S', cell: 'ZZZ9999999', value: false },
        { sheet: 'S', cell: 'a1', value: -0.5 }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits.map((edit) => edit.value)).toEqual([longValue, false, -0.5])
    expect(result.proposal.edits[1].cell).toBe('ZZZ9999999')
  })
})

describe('parseOfficeEditProposal — envelope strictness', () => {
  it('rejects invalid JSON', () => {
    const result = parseOfficeEditProposal('{not json')
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.level).toBe('error')
  })

  it('rejects non-object documents (arrays, numbers, null)', () => {
    for (const raw of ['[]', '42', 'null', '"x"']) {
      expect(parseOfficeEditProposal(raw).ok).toBe(false)
    }
  })

  it('rejects a missing or wrong version', () => {
    for (const version of [undefined, 2, '1', null, 1.5]) {
      const result = parse({ version, edits: [{ sheet: 'S', cell: 'A1', value: 'x' }] })
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a missing, non-array or empty edits array', () => {
    for (const edits of [undefined, 'nope', {}, []]) {
      const result = parse({ version: 1, edits })
      expect(result.ok).toBe(false)
    }
  })

  it('truncates to the first 200 edits with a warning', () => {
    const edit = { sheet: 'S', cell: 'A1', value: 'x' }
    const edits = Array.from({ length: OFFICE_EDIT_LIMITS.maxEdits + 7 }, () => edit)
    const result = parse({ version: 1, edits })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits).toHaveLength(OFFICE_EDIT_LIMITS.maxEdits)
    expect(result.issues).toEqual([
      { level: 'warning', edit: null, message: expect.stringContaining('200') }
    ])
  })

  it('fails when the raw text is empty or over the byte cap', () => {
    expect(parseOfficeEditProposal('').ok).toBe(false)
    expect(parseOfficeEditProposal('   \n  ').ok).toBe(false)
    const huge = `{ "version": 1, "edits": [] }${' '.repeat(OFFICE_EDIT_LIMITS.maxBytes + 1)}`
    expect(parseOfficeEditProposal(huge).ok).toBe(false)
  })
})

describe('parseOfficeEditProposal — formula-injection guard', () => {
  it('rejects string values starting with "=" outright', () => {
    const result = parse({
      version: 1,
      edits: [
        { sheet: 'S', cell: 'A1', value: '=SUM(B1:B9)' },
        { sheet: 'S', cell: 'A2', value: '=cmd|"/c calc"!A0' }
      ]
    })
    expect(result.ok).toBe(false)
    const warnings = result.issues.filter((issue) => issue.level === 'warning')
    expect(warnings).toHaveLength(2)
    expect(warnings.every((issue) => issue.message.includes('formula'))).toBe(true)
  })

  it('skips a formula value but keeps the valid edits around it', () => {
    const result = parse({
      version: 1,
      edits: [
        { sheet: 'S', cell: 'A1', value: 'plain text' },
        { sheet: 'S', cell: 'A2', value: '=1+1' },
        { sheet: 'S', cell: 'A3', value: 42 }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits).toHaveLength(2)
    expect(result.issues).toEqual([
      { level: 'warning', edit: 1, message: expect.stringContaining('=') }
    ])
  })
})

describe('parseOfficeEditProposal — per-edit leniency', () => {
  it('drops unknown fields silently', () => {
    const result = parse({
      version: 1,
      edits: [{ sheet: 'S', cell: 'A1', value: 'x', onclick: 'evil()', style: 'color: red' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits[0]).toEqual({ sheet: 'S', cell: 'A1', value: 'x' })
    expect(result.issues).toEqual([])
  })

  it('skips invalid edits with warnings and keeps the valid ones', () => {
    const result = parse({
      version: 1,
      edits: [
        'not-an-object',
        null,
        { sheet: '  ', cell: 'A1', value: 'no sheet' },
        { cell: 'A1', value: 'no sheet field' },
        { sheet: 's'.repeat(61), cell: 'A1', value: 'sheet too long' },
        { sheet: 'S', cell: 'A0', value: 'row zero' },
        { sheet: 'S', cell: 'B01', value: 'leading zero' },
        { sheet: 'S', cell: 'AAAA1', value: 'four letters' },
        { sheet: 'S', cell: 'A12345678', value: 'row too long' },
        { sheet: 'S', cell: '', value: 'empty cell' },
        { sheet: 'S', cell: 'A1' },
        { sheet: 'S', cell: 'A1', value: null },
        { sheet: 'S', cell: 'A1', value: { v: 'object' } },
        { sheet: 'S', cell: 'A1', value: [] },
        { sheet: 'S', cell: 'A1', value: 'keeper' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits).toHaveLength(1)
    expect(result.proposal.edits[0]).toEqual({ sheet: 'S', cell: 'A1', value: 'keeper' })
    expect(result.issues.filter((issue) => issue.level === 'warning')).toHaveLength(14)
  })

  it('fails when every edit is invalid', () => {
    const result = parse({ version: 1, edits: [{ sheet: 'S', cell: 'nope', value: 'x' }] })
    expect(result.ok).toBe(false)
    const errors = result.issues.filter((issue) => issue.level === 'error')
    expect(errors.some((issue) => issue.message.includes('No valid edits'))).toBe(true)
  })

  it('reports the 0-based edit index on warnings', () => {
    const result = parse({
      version: 1,
      edits: [
        { sheet: 'S', cell: 'A1', value: 'ok' },
        { sheet: 'S', cell: 'BINGO', value: 'bad cell' }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([
      { level: 'warning', edit: 1, message: expect.stringContaining('A1-style') }
    ])
  })

  it('trims sheet/cell/value strings and drops an empty note silently', () => {
    const result = parse({
      version: 1,
      edits: [{ sheet: '  Sheet 1  ', cell: ' B2 ', value: '  padded  ' }],
      note: '   '
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.edits[0]).toEqual({ sheet: 'Sheet 1', cell: 'B2', value: 'padded' })
    expect(result.proposal.note).toBeUndefined()
    expect(result.issues).toEqual([])
  })
})

describe('parseOfficeEditProposal — field bounds', () => {
  it('drops an over-long or non-string note with a warning (edits kept)', () => {
    const result = parse({
      version: 1,
      edits: [{ sheet: 'S', cell: 'A1', value: 'x' }],
      note: 'n'.repeat(OFFICE_EDIT_LIMITS.maxNoteLength + 1)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.note).toBeUndefined()
    expect(result.issues).toEqual([
      { level: 'warning', edit: null, message: expect.stringContaining('note') }
    ])

    const wrongType = parse({ version: 1, edits: [{ sheet: 'S', cell: 'A1', value: 'x' }], note: 7 })
    expect(wrongType.ok).toBe(true)
    if (!wrongType.ok) return
    expect(wrongType.proposal.note).toBeUndefined()
  })

  it('skips string values over the length cap', () => {
    const result = parse({
      version: 1,
      edits: [{ sheet: 'S', cell: 'A1', value: 'x'.repeat(OFFICE_EDIT_LIMITS.maxStringLength + 1) }]
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-finite numeric values (edit skipped)', () => {
    // JSON cannot carry NaN/Infinity, but a defensive parse still rejects them.
    const raw = '{"version":1,"edits":[{"sheet":"S","cell":"A1","value":1e999}]}'
    const result = parseOfficeEditProposal(raw)
    // 1e999 parses to Infinity → edit skipped → nothing valid → hard failure.
    expect(result.ok).toBe(false)
  })

  it('accepts zero, negative numbers and unicode sheet names', () => {
    const result = parse({
      version: 1,
      edits: [
        { sheet: '支出 2026', cell: 'C3', value: 0 },
        { sheet: 'Ω summary', cell: 'AA10', value: -12.5 }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues).toEqual([])
    expect(result.proposal.edits.map((edit) => edit.value)).toEqual([0, -12.5])
  })
})

describe('a1ToIndices — A1 notation → 0-based indices', () => {
  it('converts single and multi-letter columns', () => {
    expect(a1ToIndices('A1')).toEqual({ row: 0, column: 0 })
    expect(a1ToIndices('B2')).toEqual({ row: 1, column: 1 })
    expect(a1ToIndices('Z1')).toEqual({ row: 0, column: 25 })
    expect(a1ToIndices('AA10')).toEqual({ row: 9, column: 26 })
    expect(a1ToIndices('ZZZ9999999')).toEqual({ row: 9999998, column: 26 ** 3 + 26 ** 2 + 26 - 1 })
  })

  it('accepts lowercase references', () => {
    expect(a1ToIndices('b2')).toEqual({ row: 1, column: 1 })
  })

  it('returns null for malformed or out-of-range references', () => {
    expect(a1ToIndices('A0')).toBeNull()
    expect(a1ToIndices('')).toBeNull()
    expect(a1ToIndices('1A')).toBeNull()
    expect(a1ToIndices('AAAA1')).toBeNull()
    expect(a1ToIndices('A12345678')).toBeNull()
    expect(a1ToIndices(' A1 ')).toEqual({ row: 0, column: 0 })
  })
})
