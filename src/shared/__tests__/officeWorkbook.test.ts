import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  OFFICE_WORKBOOK_LIMITS,
  sanitizeOfficeSnapshot,
  sheetJsToUniver,
  univerToSheetJs
} from '../officeWorkbook'

function wbFromAoa(aoa: unknown[][], merges?: XLSX.Range[]): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  if (merges) ws['!merges'] = merges
  const wb: XLSX.WorkBook = { SheetNames: ['Data'], Sheets: { Data: ws } }
  return wb
}

describe('sheetJsToUniver', () => {
  it('maps number/string/boolean cells with Univer cell types', () => {
    const { snapshot, warnings } = sheetJsToUniver(wbFromAoa([['name', 42, true]]))
    expect(warnings).toEqual([])
    expect(snapshot.sheetOrder).toEqual(['sheet-0'])
    const sheet = snapshot.sheets['sheet-0']
    expect(sheet.name).toBe('Data')
    expect(sheet.hidden).toBe(0)
    expect(sheet.cellData[0][0]).toEqual({ v: 'name', t: 1 })
    expect(sheet.cellData[0][1]).toEqual({ v: 42, t: 2 })
    expect(sheet.cellData[0][2]).toEqual({ v: true, t: 3 })
  })

  it('keeps only the computed value of formula cells', () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: 'n', v: 3 },
      A2: { t: 'n', v: 4, f: 'SUM(A1)+1' },
      '!ref': 'A1:A2'
    }
    const { snapshot } = sheetJsToUniver({ SheetNames: ['S'], Sheets: { S: ws } })
    const sheet = snapshot.sheets['sheet-0']
    expect(sheet.cellData[1][0]).toEqual({ v: 4, t: 2 })
    expect('f' in sheet.cellData[1][0]).toBe(false)
  })

  it('converts dates to their formatted text', () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: 'd', v: new Date('2024-01-02T00:00:00Z'), w: '2024/1/2' },
      '!ref': 'A1'
    }
    const { snapshot } = sheetJsToUniver({ SheetNames: ['S'], Sheets: { S: ws } })
    expect(snapshot.sheets['sheet-0'].cellData[0][0]).toEqual({ v: '2024/1/2', t: 1 })
  })

  it('preserves sheet order and visibility', () => {
    const a = XLSX.utils.aoa_to_sheet([['a']])
    const b = XLSX.utils.aoa_to_sheet([['b']])
    const wb: XLSX.WorkBook = {
      SheetNames: ['First', 'Second'],
      Sheets: { First: a, Second: b },
      Workbook: { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] }
    }
    const { snapshot } = sheetJsToUniver(wb)
    expect(snapshot.sheetOrder).toEqual(['sheet-0', 'sheet-1'])
    expect(snapshot.sheets['sheet-0'].name).toBe('First')
    expect(snapshot.sheets['sheet-1'].name).toBe('Second')
    expect(snapshot.sheets['sheet-1'].hidden).toBe(1)
  })

  it('maps merge ranges and drops out-of-bounds merges with a warning', () => {
    const wb = wbFromAoa(
      [
        ['a', 'b'],
        ['c', 'd']
      ],
      [
        { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } },
        { s: { r: 0, c: 0 }, e: { r: OFFICE_WORKBOOK_LIMITS.maxRows + 10, c: 0 } }
      ]
    )
    const { snapshot, warnings } = sheetJsToUniver(wb)
    expect(snapshot.sheets['sheet-0'].mergeData).toEqual([
      { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 }
    ])
    expect(warnings).toContain('merge-dropped')
  })

  it('truncates rows/columns beyond the limits with warnings', () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: 's', v: 'ok' },
      [`A${OFFICE_WORKBOOK_LIMITS.maxRows + 1}`]: { t: 's', v: 'too deep' },
      '!ref': `A1:A${OFFICE_WORKBOOK_LIMITS.maxRows + 1}`
    }
    const { snapshot, warnings } = sheetJsToUniver({ SheetNames: ['S'], Sheets: { S: ws } })
    const sheet = snapshot.sheets['sheet-0']
    expect(sheet.cellData[OFFICE_WORKBOOK_LIMITS.maxRows]).toBeUndefined()
    expect(sheet.cellData[0][0]).toEqual({ v: 'ok', t: 1 })
    expect(sheet.rowCount).toBeLessThanOrEqual(OFFICE_WORKBOOK_LIMITS.maxRows)
    expect(warnings).toContain('too-many-rows')
  })

  it('truncates cell text beyond the Excel limit with a warning', () => {
    const long = 'x'.repeat(OFFICE_WORKBOOK_LIMITS.maxCellTextLength + 100)
    const { snapshot, warnings } = sheetJsToUniver(wbFromAoa([[long]]))
    const cell = snapshot.sheets['sheet-0'].cellData[0][0]
    expect(typeof cell.v).toBe('string')
    expect((cell.v as string).length).toBe(OFFICE_WORKBOOK_LIMITS.maxCellTextLength)
    expect(warnings).toContain('cell-text-truncated')
  })

  it('keeps at most maxSheets sheets with a warning', () => {
    const wb: XLSX.WorkBook = { SheetNames: [], Sheets: {} }
    for (let i = 0; i < OFFICE_WORKBOOK_LIMITS.maxSheets + 3; i++) {
      const name = `S${i}`
      wb.SheetNames.push(name)
      wb.Sheets[name] = XLSX.utils.aoa_to_sheet([[i]])
    }
    const { snapshot, warnings } = sheetJsToUniver(wb)
    expect(snapshot.sheetOrder.length).toBe(OFFICE_WORKBOOK_LIMITS.maxSheets)
    expect(warnings).toContain('too-many-sheets')
  })

  it('opens an empty workbook as one blank sheet', () => {
    const { snapshot } = sheetJsToUniver({ SheetNames: [], Sheets: {} })
    expect(snapshot.sheetOrder).toEqual(['sheet-0'])
    expect(snapshot.sheets['sheet-0'].rowCount).toBeGreaterThan(0)
  })
})

describe('univerToSheetJs', () => {
  it('rebuilds values, merges and visibility', () => {
    const { snapshot } = sheetJsToUniver(
      wbFromAoa([['h1', 2]], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }])
    )
    const wb = univerToSheetJs(snapshot)
    expect(wb.SheetNames).toEqual(['Data'])
    const ws = wb.Sheets.Data
    expect(ws.A1).toEqual({ t: 's', v: 'h1' })
    expect(ws.B1).toEqual({ t: 'n', v: 2 })
    expect(ws['!merges']).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }])
    expect(ws['!ref']).toBe('A1:B1')
  })

  it('sanitizes sheet names Excel rejects and keeps them unique', () => {
    const { snapshot } = sheetJsToUniver({
      SheetNames: ['a/b', 'a/b'],
      Sheets: { 'a/b': XLSX.utils.aoa_to_sheet([[1]]) } as never
    })
    // Duplicate-name sheet objects cannot exist in SheetJS; exercise the
    // sanitizer directly through a hand-built snapshot instead.
    snapshot.sheetOrder = ['s1', 's2']
    snapshot.sheets = {
      s1: { ...snapshot.sheets['sheet-0'], id: 's1', name: 'a/b' },
      s2: { ...snapshot.sheets['sheet-0'], id: 's2', name: 'a/b' }
    }
    const wb = univerToSheetJs(snapshot)
    expect(wb.SheetNames).toEqual(['a_b', 'a_b_2'])
  })

  it('round-trips through a real xlsx buffer', () => {
    const source = wbFromAoa([
      ['渠道', '消耗', '启用'],
      ['Google', 1234.5, true]
    ])
    const { snapshot } = sheetJsToUniver(source)
    const out = univerToSheetJs(snapshot)
    const buffer = XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const reread = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const { snapshot: snapshot2, warnings } = sheetJsToUniver(reread)
    expect(warnings).toEqual([])
    const sheet = snapshot2.sheets['sheet-0']
    expect(sheet.cellData[0][0]).toEqual({ v: '渠道', t: 1 })
    expect(sheet.cellData[1][1]).toEqual({ v: 1234.5, t: 2 })
    expect(sheet.cellData[1][2]).toEqual({ v: true, t: 3 })
  })
})

describe('sanitizeOfficeSnapshot', () => {
  it('passes a sheetJsToUniver snapshot through unchanged', () => {
    const { snapshot } = sheetJsToUniver(wbFromAoa([['a', 1, false]]))
    const converted = sanitizeOfficeSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(converted).not.toBeNull()
    expect(converted!.warnings).toEqual([])
    expect(converted!.snapshot).toEqual(snapshot)
  })

  it('rejects non-objects and workbooks without sheets', () => {
    expect(sanitizeOfficeSnapshot(null)).toBeNull()
    expect(sanitizeOfficeSnapshot('x')).toBeNull()
    expect(sanitizeOfficeSnapshot({ sheets: {} })).toBeNull()
    expect(sanitizeOfficeSnapshot({ sheets: [] })).toBeNull()
  })

  it('strips formulas and styles from renderer-supplied cells', () => {
    const converted = sanitizeOfficeSnapshot({
      id: 'wb',
      sheetOrder: ['s1'],
      sheets: {
        s1: {
          name: 'S',
          hidden: 0,
          rowCount: 100,
          columnCount: 10,
          cellData: {
            0: {
              0: { v: 5, t: 2, f: '=SUM(A1)', s: 'style-id' },
              1: { p: { body: { dataStream: 'rich text\r\n' } } }
            }
          },
          mergeData: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1, rangeType: 0 }]
        }
      }
    })
    expect(converted).not.toBeNull()
    const sheet = converted!.snapshot.sheets.s1
    expect(sheet.cellData[0][0]).toEqual({ v: 5, t: 2 })
    // Rich-text-only cells keep their text stream as a plain string.
    expect(sheet.cellData[0][1]).toEqual({ v: 'rich text', t: 1 })
    expect(sheet.mergeData).toEqual([{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }])
  })

  it('bounds cell coordinates and merge ranges', () => {
    const converted = sanitizeOfficeSnapshot({
      sheetOrder: ['s1'],
      sheets: {
        s1: {
          name: 'S',
          cellData: {
            [OFFICE_WORKBOOK_LIMITS.maxRows + 5]: { 0: { v: 'nope', t: 1 } },
            '-1': { 0: { v: 'nope', t: 1 } },
            0: { [OFFICE_WORKBOOK_LIMITS.maxColumns + 5]: { v: 'nope', t: 1 }, 1: { v: 'ok', t: 1 } }
          },
          mergeData: [{ startRow: 'a', startColumn: 0, endRow: 1, endColumn: 1 }]
        }
      }
    })
    const sheet = converted!.snapshot.sheets.s1
    expect(Object.keys(sheet.cellData)).toEqual(['0'])
    expect(sheet.cellData[0]).toEqual({ 1: { v: 'ok', t: 1 } })
    expect(sheet.mergeData).toEqual([])
    expect(converted!.warnings).toContain('merge-dropped')
  })
})
