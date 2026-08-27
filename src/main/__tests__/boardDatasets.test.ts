import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'

// boardDatasets.ts resolves its default store through electron's app.getPath;
// tests mostly inject an explicit file, and the default-path case reads
// userDataDir which beforeEach points at a fresh temp dir.
let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { deleteDataset, importDataset, listDatasets, renameDataset } from '../boardDatasets'
import { DATASET_LIMITS } from '../../shared/datasets'
import { BoardDataset } from '../../shared/types'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-datasets-'))
  userDataDir = dir
  file = path.join(dir, 'board-datasets.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeFixture(name: string, content: string | Buffer): string {
  const p = path.join(dir, name)
  writeFileSync(p, content)
  return p
}

const CSV = '日期,渠道,消耗\n2024-01-01,Google,"$1,234.56"\n2024-01-02,Meta,(100)\n'

function makeDataset(id: string): BoardDataset {
  return {
    id,
    name: `Dataset ${id}`,
    columns: [{ name: 'n', type: 'number' }],
    rows: [[1]],
    createdAt: 1000
  }
}

describe('listDatasets', () => {
  it('returns an empty list only when the file is missing and surfaces corrupt stores', () => {
    expect(listDatasets(file)).toEqual([])
    writeFileSync(file, '{not json')
    expect(() => listDatasets(file)).toThrow('The local datasets file is not valid JSON.')
    writeFileSync(file, JSON.stringify({ datasets: [] }))
    expect(() => listDatasets(file)).toThrow('The local datasets file has an invalid format.')
  })

  it('drops invalid entries but keeps the valid ones', () => {
    writeFileSync(file, JSON.stringify([makeDataset('good'), { id: 'bad' }, null]))
    expect(listDatasets(file).map((d) => d.id)).toEqual(['good'])
  })
})

describe('importDataset', () => {
  it('refuses to overwrite a corrupt dataset store', () => {
    writeFileSync(file, '{not json')
    const csv = writeFixture('new.csv', 'a\n1\n')
    const before = readFileSync(file, 'utf-8')
    expect(importDataset(csv, file)).toEqual({ ok: false, error: 'dataset-store-unreadable' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('imports a CSV, infers types, cleans values and round-trips', () => {
    const csv = writeFixture('谷歌日报.csv', CSV)
    const result = importDataset(csv, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(false)
    expect(result.dataset.name).toBe('谷歌日报')
    expect(result.dataset.columns).toEqual([
      { name: '日期', type: 'date' },
      { name: '渠道', type: 'text' },
      { name: '消耗', type: 'number' }
    ])
    expect(result.dataset.rows).toEqual([
      ['2024-01-01', 'Google', 1234.56],
      ['2024-01-02', 'Meta', -100]
    ])
    expect(listDatasets(file)).toEqual([result.dataset])
  })

  it('imports an XLSX generated on the fly (first sheet)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['渠道', '消耗'],
      ['Google', '10'],
      ['Meta', '20.5']
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Report')
    const xlsxPath = writeFixture('report.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const result = importDataset(xlsxPath, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.name).toBe('report')
    expect(result.dataset.columns).toEqual([
      { name: '渠道', type: 'text' },
      { name: '消耗', type: 'number' }
    ])
    expect(result.dataset.rows).toEqual([
      ['Google', 10],
      ['Meta', 20.5]
    ])
  })

  it('truncates rows beyond the limit and flags the result', () => {
    const lines = ['n']
    for (let i = 0; i < DATASET_LIMITS.maxRows + 5; i++) lines.push(String(i))
    const csv = writeFixture('tall.csv', lines.join('\n'))
    const result = importDataset(csv, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.dataset.rows).toHaveLength(DATASET_LIMITS.maxRows)
  })

  it('truncates columns beyond the limit and flags the result', () => {
    const cols = DATASET_LIMITS.maxColumns + 5
    const csv = writeFixture(
      'wide.csv',
      `${Array.from({ length: cols }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: cols }, () => '1').join(',')}\n`
    )
    const result = importDataset(csv, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.dataset.columns).toHaveLength(DATASET_LIMITS.maxColumns)
    expect(result.dataset.rows[0]).toHaveLength(DATASET_LIMITS.maxColumns)
  })

  it('enforces the dataset limit', () => {
    writeFileSync(
      file,
      JSON.stringify(Array.from({ length: DATASET_LIMITS.maxDatasets }, (_, i) => makeDataset(`d-${i}`)))
    )
    const csv = writeFixture('one-more.csv', 'a\n1\n')
    const result = importDataset(csv, file)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('dataset-limit')
    expect(listDatasets(file)).toHaveLength(DATASET_LIMITS.maxDatasets)
  })

  it('rejects bad input honestly instead of throwing', () => {
    const missing = importDataset(path.join(dir, 'nope.csv'), file)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toBe('invalid-path')

    const wrongExt = writeFixture('data.json', '{}')
    const unsupported = importDataset(wrongExt, file)
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error).toBe('unsupported-type')

    const notString = importDataset(42, file)
    expect(notString.ok).toBe(false)
    if (!notString.ok) expect(notString.error).toBe('invalid-path')

    const emptyCsv = writeFixture('empty.csv', '')
    const empty = importDataset(emptyCsv, file)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toBe('empty')

    // PK-signature garbage makes the xlsx parser throw → parse-failed.
    const badXlsx = writeFixture('broken.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]))
    const broken = importDataset(badXlsx, file)
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error).toBe('parse-failed')
  })

  it('rejects files over the size limit', () => {
    const big = writeFixture('big.csv', `a\n${'1\n'.repeat(1)}${'x'.repeat(DATASET_LIMITS.maxFileBytes)}`)
    const result = importDataset(big, file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('file-too-large')
  })

  it('writes to userData/board-datasets.json by default', () => {
    const csv = writeFixture('default.csv', 'a\n1\n')
    const result = importDataset(csv)
    expect(result.ok).toBe(true)
    const target = path.join(userDataDir, 'board-datasets.json')
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf-8'))[0].name).toBe('default')
    expect(listDatasets()).toHaveLength(1)
  })
})

describe('deleteDataset', () => {
  it('refuses to overwrite a corrupt dataset store', () => {
    writeFileSync(file, '{not json')
    const before = readFileSync(file, 'utf-8')
    expect(deleteDataset('a', file)).toEqual({ ok: false, error: 'dataset-store-unreadable' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('removes the dataset and keeps the rest', () => {
    const csv = writeFixture('a.csv', 'a\n1\n')
    const first = importDataset(csv, file)
    const csv2 = writeFixture('b.csv', 'b\n2\n')
    const second = importDataset(csv2, file)
    if (!first.ok || !second.ok) throw new Error('setup failed')
    expect(deleteDataset(first.dataset.id, file)).toEqual({ ok: true })
    expect(listDatasets(file).map((d) => d.id)).toEqual([second.dataset.id])
  })

  it('treats deleting an absent dataset as an idempotent no-op', () => {
    writeFileSync(file, JSON.stringify([makeDataset('a')]))
    const before = readFileSync(file, 'utf-8')
    expect(deleteDataset('absent', file)).toEqual({ ok: true })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('rejects invalid ids', () => {
    expect(deleteDataset(42, file).ok).toBe(false)
    expect(deleteDataset('', file).ok).toBe(false)
  })
})

describe('renameDataset', () => {
  it('refuses to overwrite a corrupt dataset store', () => {
    writeFileSync(file, '{not json')
    const before = readFileSync(file, 'utf-8')
    expect(renameDataset('a', 'Renamed', file)).toEqual({ ok: false, error: 'dataset-store-unreadable' })
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('renames and persists', () => {
    writeFileSync(file, JSON.stringify([makeDataset('a')]))
    expect(renameDataset('a', '新名字', file)).toEqual({ ok: true })
    expect(listDatasets(file)[0].name).toBe('新名字')
  })

  it('rejects invalid names and reports unknown ids', () => {
    writeFileSync(file, JSON.stringify([makeDataset('a')]))
    expect(renameDataset('a', '   ', file).ok).toBe(false)
    expect(renameDataset('a', 'x'.repeat(DATASET_LIMITS.maxNameLength + 1), file).ok).toBe(false)
    const missing = renameDataset('nope', 'valid', file)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toBe('not-found')
  })
})
