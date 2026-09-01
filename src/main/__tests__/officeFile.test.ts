import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'

// officeFile.ts uses electron only for the native dialogs; mock them per test.
const showOpenDialog = vi.fn()
const showSaveDialog = vi.fn()
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args)
  }
}))

import {
  OFFICE_FILE_MAX_BYTES,
  OFFICE_SNAPSHOT_MAX_JSON_BYTES,
  officeOpenDialog,
  officeSaveDialog,
  readOfficeWorkbook,
  saveOfficeWorkbook,
  validateOfficePath
} from '../officeFile'
import { getOperationGrantManager } from '../operationGrant'
import { sheetJsToUniver } from '../../shared/officeWorkbook'
import { expectSamePath } from './pathAssertions'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-office-'))
  showOpenDialog.mockReset()
  showSaveDialog.mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeXlsxFixture(name: string, aoa: unknown[][]): string {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb: XLSX.WorkBook = { SheetNames: ['Data'], Sheets: { Data: ws } }
  const p = path.join(dir, name)
  writeFileSync(p, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  return p
}

describe('validateOfficePath', () => {
  it('rejects non-strings, control chars, and overlong paths', async () => {
    expect(await validateOfficePath(undefined)).toBeNull()
    expect(await validateOfficePath(42)).toBeNull()
    expect(await validateOfficePath('')).toBeNull()
    expect(await validateOfficePath('a'.repeat(1025))).toBeNull()
    expect(await validateOfficePath('/tmp/a\0.xlsx')).toBeNull()
  })

  it('rejects unsupported extensions, missing files, and directories', async () => {
    const txt = path.join(dir, 'a.txt')
    writeFileSync(txt, 'hi')
    expect(await validateOfficePath(txt)).toBeNull()
    expect(await validateOfficePath(path.join(dir, 'missing.xlsx'))).toBeNull()
    expect(await validateOfficePath(dir)).toBeNull()
  })

  it('rejects files over the size limit', async () => {
    const big = path.join(dir, 'big.xlsx')
    writeFileSync(big, 'PK')
    truncateSync(big, OFFICE_FILE_MAX_BYTES + 1)
    expect(await validateOfficePath(big)).toBeNull()
  })

  it('accepts a real workbook and resolves symlinks to the real path', async () => {
    const real = writeXlsxFixture('real.xlsx', [['a']])
    const link = path.join(dir, 'link.xlsx')
    symlinkSync(real, link)
    const canonical = realpathSync(real)
    expectSamePath(await validateOfficePath(link), canonical)
    expectSamePath(await validateOfficePath(real), canonical)
  })
})

describe('officeOpenDialog + read grant', () => {
  it('returns null when the user cancels', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await officeOpenDialog(1)).toBeNull()
  })

  it('mints a one-shot read grant for the picked file', async () => {
    const file = writeXlsxFixture('picked.xlsx', [['k', 1]])
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    const picked = await officeOpenDialog(7)
    expect(picked?.grant.purpose).toBe('office-open')
    expect(picked?.name).toBe('picked.xlsx')
    const manager = getOperationGrantManager()
    expect(await manager.consumeOfficeFile(picked!.grant.id, 8)).toBeNull()
    expectSamePath(await manager.consumeOfficeFile(picked!.grant.id, 7), realpathSync(file))
    // One-shot: a second consume fails.
    expect(await manager.consumeOfficeFile(picked!.grant.id, 7)).toBeNull()
  })
})

describe('readOfficeWorkbook', () => {
  it('parses xlsx into a snapshot', async () => {
    const file = writeXlsxFixture('data.xlsx', [
      ['渠道', '消耗'],
      ['Google', 12.5]
    ])
    const result = await readOfficeWorkbook(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.name).toBe('data.xlsx')
    expect(result.snapshot.sheets['sheet-0'].cellData[1][0]).toEqual({ v: 'Google', t: 1 })
    expect(result.snapshot.sheets['sheet-0'].cellData[1][1]).toEqual({ v: 12.5, t: 2 })
  })

  it('parses csv as a single sheet', async () => {
    const file = path.join(dir, 'data.csv')
    writeFileSync(file, 'a,b\n1,2\n')
    const result = await readOfficeWorkbook(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.sheetOrder).toHaveLength(1)
    expect(result.snapshot.sheets['sheet-0'].cellData[0][0]).toEqual({ v: 'a', t: 1 })
  })

  it('rejects oversized files before parsing', async () => {
    const big = path.join(dir, 'big.csv')
    writeFileSync(big, 'a')
    truncateSync(big, OFFICE_FILE_MAX_BYTES + 1)
    const result = await readOfficeWorkbook(big)
    expect(result).toEqual({ ok: false, error: 'file-too-large' })
  })

  it('reports parse failures', async () => {
    const bad = path.join(dir, 'bad.xlsx')
    writeFileSync(bad, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64, 7)]))
    const result = await readOfficeWorkbook(bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('parse-failed')
  })
})

describe('officeSaveDialog + save grant', () => {
  it('returns null when the user cancels', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await officeSaveDialog('w.xlsx', 1)).toBeNull()
  })

  it('appends .xlsx when the target has no office extension', async () => {
    const target = path.join(dir, 'out')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    const picked = await officeSaveDialog('w', 3)
    expect(picked?.name).toBe('out.xlsx')
    const manager = getOperationGrantManager()
    expectSamePath(await manager.consumeOfficeSaveTarget(picked!.grant.id, 3), path.join(realpathSync(dir), 'out.xlsx'))
  })

  it('keeps a csv target', async () => {
    const target = path.join(dir, 'out.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    const picked = await officeSaveDialog('w', 4)
    expect(picked?.name).toBe('out.csv')
    const manager = getOperationGrantManager()
    expectSamePath(await manager.consumeOfficeSaveTarget(picked!.grant.id, 4), path.join(realpathSync(dir), 'out.csv'))
  })

  it('fails minting when the parent directory does not exist', async () => {
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: path.join(dir, 'nope', 'out.xlsx')
    })
    expect(await officeSaveDialog('w', 5)).toBeNull()
  })
})

describe('saveOfficeWorkbook', () => {
  function sampleSnapshot() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['h', 1],
      ['r', 2]
    ])
    return sheetJsToUniver({ SheetNames: ['Data'], Sheets: { Data: ws } }).snapshot
  }

  it('writes xlsx atomically and the result parses back', async () => {
    const target = path.join(dir, 'saved.xlsx')
    const result = await saveOfficeWorkbook(target, sampleSnapshot())
    expect(result).toEqual({ ok: true })
    expect(existsSync(target)).toBe(true)
    expect(existsSync(`${target}.tmp-${process.pid}`)).toBe(false)
    const reread = XLSX.read(readFileSync(target), { type: 'buffer' })
    const ws = reread.Sheets.Data
    expect(ws.A1.v).toBe('h')
    expect(ws.B2.v).toBe(2)
  })

  it('writes csv targets as csv', async () => {
    const target = path.join(dir, 'saved.csv')
    const result = await saveOfficeWorkbook(target, sampleSnapshot())
    expect(result).toEqual({ ok: true })
    const text = readFileSync(target, 'utf-8')
    expect(text).toContain('h,1')
  })

  it('rejects invalid snapshots', async () => {
    const target = path.join(dir, 'x.xlsx')
    expect(await saveOfficeWorkbook(target, null)).toEqual({ ok: false, error: 'invalid-snapshot' })
    expect(await saveOfficeWorkbook(target, { sheets: {} })).toEqual({ ok: false, error: 'invalid-snapshot' })
    expect(existsSync(target)).toBe(false)
  })

  it('rejects oversized snapshots before conversion', async () => {
    const target = path.join(dir, 'x.xlsx')
    const huge = { sheets: { s1: { blob: 'x'.repeat(OFFICE_SNAPSHOT_MAX_JSON_BYTES) } } }
    const result = await saveOfficeWorkbook(target, huge)
    expect(result).toEqual({ ok: false, error: 'snapshot-too-large' })
  })

  it('reports write failures without leaving a tmp file', async () => {
    const target = path.join(dir, 'missing-dir', 'x.xlsx')
    const result = await saveOfficeWorkbook(target, sampleSnapshot())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('write-failed')
  })
})
