import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
let userDataDir = ''
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
import { DATASET_LIMITS, buildDataset, validateDataset } from '../../../shared/datasets'
import { createOrUpdateDataset, listDatasets } from '../../boardDatasets'
import type { TikTokReportRow } from './tiktokClient'
import { beginTikTokDatasetRead, mergeReportRowsIntoDataset, reportRowsToGrid, TIKTOK_DATASET_NAME, type TikTokDatasetScope } from './tiktokReportDataset'
let dir: string, file: string
const A = '7300000000000000001', B = '7300000000000000002'
const details = new Map([[A, { name: 'Same', currency: 'USD', timezone: 'UTC' }], [B, { name: 'Same', currency: 'USD', timezone: 'UTC' }]])
const scope = (advertiserId: string, startDate = '2026-01-01', endDate = '2026-01-02'): TikTokDatasetScope => ({ advertiserId, startDate, endDate, source: 'mcp' })
function row(advertiserId = A, date = '2026-01-01', spend = 10, campaignId = '100'): TikTokReportRow {
  return { advertiserId, campaignId, date, campaignName: 'Test', spend, impressions: 100, clicks: 10, ctr: null, cpc: null, conversion: 1, costPerConversion: null }
}
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'tt-dataset-')); userDataDir = dir; file = path.join(dir, 'data.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('stable report data and atomic migration', () => {
  it('rejects an older overlapping response after a newer request commits while allowing disjoint windows', () => {
    const older = beginTikTokDatasetRead()
    const newer = beginTikTokDatasetRead()
    expect(mergeReportRowsIntoDataset([row(A, '2026-01-01', 20)], details, file, [scope(A)], newer).ok).toBe(true)
    const before = readFileSync(file, 'utf8')
    expect(mergeReportRowsIntoDataset([row(A, '2026-01-01', 10)], details, file, [scope(A)], older)).toMatchObject({ ok: false, error: 'superseded' })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(mergeReportRowsIntoDataset([row(A, '2026-01-03', 30)], details, file, [scope(A, '2026-01-03', '2026-01-03')], older).ok).toBe(true)
  })

  it('does not block an older response when the newer request failed to save', () => {
    const older = beginTikTokDatasetRead(), newer = beginTikTokDatasetRead()
    expect(mergeReportRowsIntoDataset([row(), row()], details, file, [scope(A)], newer).ok).toBe(false)
    expect(mergeReportRowsIntoDataset([row()], details, file, [scope(A)], older).ok).toBe(true)
  })

  it('preserves long IDs as exact strings and records account timezone and source', () => {
    const result = mergeReportRowsIntoDataset([row()], details, file, [scope(A)])
    expect(result.ok).toBe(true)
    const d = listDatasets(file)[0]
    expect(validateDataset(d)).not.toBeNull()
    expect(d.columns.map((c) => c.name)).toEqual(reportRowsToGrid([]).headers)
    expect(d.rows[0].slice(11)).toEqual([A, '100', 'UTC', 'mcp'])
    expect(d.columns[11].type).toBe('text')
  })

  it('keeps same-named accounts distinct, even when one account is renamed', () => {
    expect(mergeReportRowsIntoDataset([row(A), row(B, '2026-01-01', 20)], details, file, [scope(A), scope(B)]).ok).toBe(true)
    const renamed = new Map([[A, { name: 'Renamed', currency: 'USD', timezone: 'UTC' }]])
    expect(mergeReportRowsIntoDataset([row(A, '2026-01-01', 30)], renamed, file, [scope(A)]).ok).toBe(true)
    const rows = listDatasets(file)[0].rows
    expect(rows.map((r) => [r[11], r[1], r[3]])).toEqual([[B, 'Same', 20], [A, 'Renamed', 30]])
  })

  it('clears zero-row successful scopes without removing other accounts or dates', () => {
    expect(mergeReportRowsIntoDataset([row(A), row(A, '2026-01-02', 11), row(B, '2026-01-01', 20)], details, file, [scope(A), scope(B)]).ok).toBe(true)
    expect(mergeReportRowsIntoDataset([], details, file, [scope(A, '2026-01-01', '2026-01-01')]).ok).toBe(true)
    expect(listDatasets(file)[0].rows.map((r) => [r[11], r[0]])).toEqual([[A, '2026-01-02'], [B, '2026-01-01']])
  })

  it('backs up legacy data intact while keeping old ID for the new dataset', () => {
    const built = buildDataset(['日期', '活动名称', '消耗'], [['2026-01-01', 'Legacy', '77']])
    const old = createOrUpdateDataset(TIKTOK_DATASET_NAME, built, file)
    if (!old.ok) throw new Error(old.error)
    const result = mergeReportRowsIntoDataset([row()], details, file, [scope(A)])
    if (!result.ok) throw new Error(result.error)
    expect(result.dataset.id).toBe(old.dataset.id)
    expect(result.legacyBackups).toHaveLength(1)
    const all = listDatasets(file)
    const backup = all.find((d) => d.name === result.legacyBackups![0])!
    expect(backup.id).not.toBe(old.dataset.id)
    expect(backup.columns).toEqual(old.dataset.columns)
    expect(backup.rows).toEqual(old.dataset.rows)
    expect(all.find((d) => d.name === TIKTOK_DATASET_NAME)!.rows[0][11]).toBe(A)
    const again = mergeReportRowsIntoDataset([row()], details, file, [scope(A)])
    expect(again.ok && again.legacyBackups).toEqual(result.legacyBackups)
  })

  it('does not alter legacy data when no backup slot exists', () => {
    const old = createOrUpdateDataset(TIKTOK_DATASET_NAME, buildDataset(['old'], [['user data']]), file)
    expect(old.ok).toBe(true)
    for (let i = 0; i < DATASET_LIMITS.maxDatasets - 1; i++) expect(createOrUpdateDataset(`filler-${i}`, buildDataset(['v'], [['1']]), file).ok).toBe(true)
    const before = readFileSync(file, 'utf8')
    expect(mergeReportRowsIntoDataset([row()], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'dataset-limit' })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses a >10000-row merge and preserves the existing file byte-for-byte', () => {
    const rows = Array.from({ length: 9999 }, (_, i) => row(A, new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10)))
    expect(mergeReportRowsIntoDataset(rows, details, file).ok).toBe(true)
    const before = readFileSync(file, 'utf8')
    const next = [row(B, '2030-01-01'), row(B, '2030-01-02')]
    expect(mergeReportRowsIntoDataset(next, details, file, [scope(B, '2030-01-01', '2030-01-02')])).toMatchObject({ ok: false, error: 'row-limit' })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(listDatasets(file)[0].rows).toHaveLength(9999)
  })

  it('never rewrites another invalid dataset while syncing', () => {
    const raw = JSON.stringify([{ id: 'broken', name: 'Other', columns: [], rows: [null], createdAt: 1 }])
    writeFileSync(file, raw)
    expect(mergeReportRowsIntoDataset([row()], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'dataset-store-unreadable' })
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })
  it('leaves the previous file byte-for-byte unchanged when pre-commit hashing fails', () => {
    expect(mergeReportRowsIntoDataset([row()], details, file, [scope(A)]).ok).toBe(true)
    const before = readFileSync(file, 'utf8')
    const hash = vi.fn(() => { throw new Error('simulated SHA-256 failure') })
    const result = mergeReportRowsIntoDataset([row(A, '2026-01-01', 20)], details, file, [scope(A)], undefined, hash)
    expect(result).toMatchObject({ ok: false, error: 'write-failed', detail: 'proof-failed' })
    expect(hash).toHaveBeenCalledOnce()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('backs up a malformed current table instead of merging duplicate identities', () => {
    const first = mergeReportRowsIntoDataset([row()], details, file, [scope(A)])
    if (!first.ok) throw new Error(first.error)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Array<{ rows: unknown[][] }>
    stored[0].rows.push([...stored[0].rows[0]])
    writeFileSync(file, JSON.stringify(stored))
    const result = mergeReportRowsIntoDataset([row(A, '2026-01-01', 12)], details, file, [scope(A)])
    if (!result.ok) throw new Error(result.error)
    expect(result.dataset.rows).toHaveLength(1)
    const backup = listDatasets(file).find((dataset) => dataset.name === result.legacyBackups?.[0])
    expect(backup?.rows).toHaveLength(2)
  })

  it('preserves extension metadata when updating a current report dataset', () => {
    const first = mergeReportRowsIntoDataset([row()], details, file, [scope(A)])
    if (!first.ok) throw new Error(first.error)
    const original = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    original[0].customMetadata = { note: 'kept' }
    writeFileSync(file, JSON.stringify(original))
    expect(mergeReportRowsIntoDataset([row(A, '2026-01-01', 12)], details, file, [scope(A)]).ok).toBe(true)
    const updated = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    expect(updated[0].customMetadata).toEqual({ note: 'kept' })
  })

  it('does not migrate when another dataset shares the target ID', () => {
    const old = createOrUpdateDataset(TIKTOK_DATASET_NAME, buildDataset(['old'], [['legacy']]), file)
    if (!old.ok) throw new Error(old.error)
    const other = { ...old.dataset, name: 'Other' }
    const raw = JSON.stringify([old.dataset, other])
    writeFileSync(file, raw)
    expect(mergeReportRowsIntoDataset([row()], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'ambiguous-dataset' })
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })

  it('refuses duplicate identities, missing IDs and rows outside the declared scope', () => {
    expect(mergeReportRowsIntoDataset([row(), row()], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'invalid-scope' })
    expect(mergeReportRowsIntoDataset([{ ...row(), campaignId: undefined }], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'invalid-scope' })
    expect(mergeReportRowsIntoDataset([row(B)], details, file, [scope(A)])).toMatchObject({ ok: false, error: 'invalid-scope' })
    expect(mergeReportRowsIntoDataset([], details, file)).toMatchObject({ ok: false, error: 'invalid-scope' })
  })
})
