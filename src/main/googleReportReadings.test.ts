import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { importGoogleReportFile, readGoogleReportReadings } from './googleReportReadings'

const dir = mkdtempSync(path.join(os.tmpdir(), 'google-report-test-'))
afterEach(() => { rmSync(dir, { recursive: true, force: true }); require('node:fs').mkdirSync(dir) })
describe('Google report persistence', () => {
  it('ignores corrupted stored accounts rather than trusting shallow shapes', () => {
    const store = path.join(dir, 'bad.json')
    writeFileSync(store, JSON.stringify({ 'widget-1': { widgetId: 'widget-1', importedAt: 1, fileName: 'x.csv', contractVersion: 1, warnings: [], summary: { windowStart: '2026-10-01', windowEnd: '2026-10-07', accounts: [{ accountId: 'wrong', currency: 'USD', campaigns: [] }] } } }))
    expect(readGoogleReportReadings(store)).toEqual({})
  })
  it('reads UTF-16LE CSV with BOM and writes restricted storage', () => {
    const file = path.join(dir, 'utf16.csv'), store = path.join(dir, 'readings.json')
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('2026-10-01 - 2026-10-07\nCustomer ID,Currency,Campaign,Cost\n123-456-7890,USD,Search,12', 'utf16le')]))
    expect(importGoogleReportFile('widget-1', file, store).reading?.summary.accounts[0].spend).toBe(12)
    expect(require('node:fs').statSync(store).mode & 0o777).toBe(0o600)
  })
  it('keeps the verified reading when a later import fails validation', () => {
    const file = path.join(dir, 'report.csv'), store = path.join(dir, 'readings.json')
    writeFileSync(file, '2026-10-01 - 2026-10-07\nCustomer ID,Currency,Campaign,Cost\n123-456-7890,USD,Search,12')
    const first = importGoogleReportFile('widget-1', file, store)
    expect(first.reading?.summary.accounts[0].spend).toBe(12)
    const before = readFileSync(store, 'utf8')
    writeFileSync(file, 'Customer ID,Currency,Campaign,Cost\n123-456-7890,USD,Search,99')
    expect(importGoogleReportFile('widget-1', file, store).outcome?.verification.verified).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readGoogleReportReadings(store)['widget-1'].summary.accounts[0].spend).toBe(12)
  })
})
