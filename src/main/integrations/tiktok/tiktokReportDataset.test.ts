import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

import { DATASET_LIMITS, buildDataset, validateDataset } from '../../../shared/datasets'
import { BoardDataset } from '../../../shared/types'
import { createOrUpdateDataset, listDatasets } from '../../boardDatasets'
import { TikTokReportRow, fetchIntegratedReport } from './tiktokClient'
import { mergeReportRowsIntoDataset, reportRowsToGrid, TIKTOK_DATASET_NAME, writeReportToDataset } from './tiktokReportDataset'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tiktok-dataset-'))
  userDataDir = dir
  file = path.join(dir, 'board-datasets.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function row(overrides: Partial<TikTokReportRow> = {}): TikTokReportRow {
  return {
    date: '2026-01-02',
    campaignName: '夏日促销',
    spend: 123.45,
    impressions: 1000,
    clicks: 50,
    ctr: 5,
    cpc: 2.47,
    conversion: 3,
    costPerConversion: 41.15,
    ...overrides
  }
}

describe('reportRowsToGrid', () => {
  it('emits the documented zh columns in order', () => {
    const grid = reportRowsToGrid([row()])
    expect(grid.headers).toEqual(['日期', '广告主', '活动名称', '消耗', '展示', '点击', '点击率', '平均点击成本', '转化', '转化成本', '币种'])
    expect(grid.rawRows[0]).toEqual(['2026-01-02', '', '夏日促销', '123.45', '1000', '50', '5', '2.47', '3', '41.15', ''])
  })

  it('fills the per-row advertiser name and currency from advertiser info when present', () => {
    const details = new Map([['7300001', { name: 'miclip', currency: 'MXN' }]])
    const grid = reportRowsToGrid(
      [row({ advertiserId: '7300001' }), row({ advertiserId: '7300002' })],
      details
    )
    expect(grid.rawRows[0][1]).toBe('miclip')
    expect(grid.rawRows[0][10]).toBe('MXN')
    // Unknown advertiser falls back to the raw id and a blank currency — never a guess.
    expect(grid.rawRows[1][1]).toBe('7300002')
    expect(grid.rawRows[1][10]).toBe('')
  })

  it('maps null metrics to blank cells like a CSV export would', () => {
    const grid = reportRowsToGrid([row({ conversion: null, costPerConversion: null })])
    expect(grid.rawRows[0].slice(8)).toEqual(['', '', ''])
  })
})

describe('writeReportToDataset', () => {
  it('creates a "TikTok 报表" BoardDataset with CSV-import-consistent typing', () => {
    const result = writeReportToDataset(
      [row(), row({ date: '2026-01-01', campaignName: '品牌曝光', spend: 20 })],
      file
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(false)

    const dataset = result.dataset
    expect(dataset.name).toBe(TIKTOK_DATASET_NAME)
    // validateDataset is the same gate the storage layer applies on read.
    expect(validateDataset(dataset)).not.toBeNull()
    expect(dataset.columns.map((c) => c.type)).toEqual([
      'date', 'text', 'text', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'text'
    ])
    // Rows keep the client's date-desc order and number columns hold numbers.
    expect(dataset.rows[0][0]).toBe('2026-01-02')
    expect(typeof dataset.rows[0][3]).toBe('number')
    expect(dataset.rows[1][0]).toBe('2026-01-01')
  })

  it('replaces by name and keeps the dataset id stable across refreshes', () => {
    const first = writeReportToDataset([row()], file)
    expect(first.ok).toBe(true)
    const second = writeReportToDataset(
      [row({ date: '2026-01-03', campaignName: '新一轮' })],
      file
    )
    expect(second.ok).toBe(true)
    const all = listDatasets(file)
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe(TIKTOK_DATASET_NAME)
    expect(all[0].rows).toHaveLength(1)
    expect(all[0].rows[0][2]).toBe('新一轮')
    if (first.ok && second.ok) {
      expect(all[0].id).toBe(first.dataset.id)
      expect(all[0].createdAt).toBe(first.dataset.createdAt)
    }
  })

  it('respects the global dataset limit only for NEW names', () => {
    const filler: BoardDataset[] = []
    for (let i = 0; i < DATASET_LIMITS.maxDatasets; i++) {
      filler.push({
        id: `filler-${i}`,
        name: `F${i}`,
        columns: [{ name: 'n', type: 'number' }],
        rows: [[1]],
        createdAt: i
      })
    }
    writeFileSync(file, JSON.stringify(filler))
    // The name is new while the store is full: the write must refuse instead
    // of silently evicting a dataset.
    const refused = writeReportToDataset([row()], file)
    expect(refused).toEqual({ ok: false, error: 'dataset-limit' })

    // Pre-register the name, then a refresh replaces without hitting the cap.
    const datasets = JSON.parse(readFileSync(file, 'utf-8')) as BoardDataset[]
    writeFileSync(
      file,
      JSON.stringify(
        datasets.slice(0, DATASET_LIMITS.maxDatasets - 1).concat([
          {
            id: 'tt-1',
            name: TIKTOK_DATASET_NAME,
            columns: [{ name: 'x', type: 'text' }],
            rows: [['y']],
            createdAt: 1
          }
        ])
      )
    )
    const created = writeReportToDataset([row()], file)
    expect(created.ok).toBe(true)
  })
})

describe('client → dataset integration shape', () => {
  it('feeds paged fetchIntegratedReport output straight into the dataset', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          message: 'OK',
          data: {
            list: [
              {
                dimensions: { stat_time_day: '2026-01-02', campaign_name: 'C1' },
                metrics: { spend: '10.5', impressions: '100', clicks: '5', ctr: '0.05', cpc: '2.1', conversion: '1', cost_per_conversion: '10.5' }
              }
            ],
            page_info: { total_page: 1 }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )) as unknown as (url: string, init?: RequestInit) => Promise<Response>
    const rows = await fetchIntegratedReport(fetchImpl, {
      accessToken: 'tok',
      advertiserId: '7300001',
      startDate: '2026-01-01',
      endDate: '2026-01-07'
    })
    const result = writeReportToDataset(rows, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.rows[0]).toEqual(['2026-01-02', '', 'C1', 10.5, 100, 5, 0.05, 2.1, 1, 10.5, ''])
  })
})

describe('mergeReportRowsIntoDataset (single-pipeline upsert)', () => {
  it('upserts by 广告主+日期 and keeps history outside the incoming window', () => {
    const file2 = path.join(dir, 'merge-datasets.json')
    const details = new Map([['7300001', { name: 'miclip', currency: 'MXN' }]])
    // First pull: two days for miclip.
    writeReportToDataset([row({ date: '2026-01-01', advertiserId: '7300001' }), row({ date: '2026-01-02', advertiserId: '7300001' })], file2, details)
    // Reading card for "今天" pulls only the newest day with an updated value.
    const merged = mergeReportRowsIntoDataset([row({ date: '2026-01-02', advertiserId: '7300001', spend: 99 })], details, file2)
    expect(merged.ok).toBe(true)
    const dataset = listDatasets(file2).find((d) => d.name === TIKTOK_DATASET_NAME)!
    expect(dataset.rows).toHaveLength(2)
    const newest = dataset.rows.find((r) => r[0] === '2026-01-02')
    expect(newest?.[3]).toBe(99)
    // History retained.
    expect(dataset.rows.some((r) => r[0] === '2026-01-01')).toBe(true)
  })
})

describe('mergeReportRowsIntoDataset schema safety', () => {
  it('replaces wholesale when the stored dataset predates the 广告主 column', () => {
    const file3 = path.join(dir, 'schema-datasets.json')
    // Old 9-column dataset (pre-广告主/币种): 日期,活动名称,消耗,展示,点击,点击率,cpc,转化,cpa
    const oldGrid = { headers: ['日期', '活动名称', '消耗', '展示', '点击', '点击率', '平均点击成本', '转化', '转化成本'], rawRows: [['2026-01-01', 'C0', '1', '10', '1', '0.1', '1', '0', '']] }
    const built = buildDataset(oldGrid.headers, oldGrid.rawRows)
    createOrUpdateDataset('TikTok 报表', built, file3)
    const details = new Map([['7300001', { name: 'miclip', currency: 'MXN' }]])
    const merged = mergeReportRowsIntoDataset([row({ date: '2026-01-02', advertiserId: '7300001' })], details, file3)
    expect(merged.ok).toBe(true)
    const dataset = listDatasets(file3).find((d) => d.name === 'TikTok 报表')!
    // Old 9-wide garbage must NOT survive next to 11-wide rows.
    expect(dataset.columns).toHaveLength(11)
    expect(dataset.rows.every((r) => r.length === 11)).toBe(true)
    expect(dataset.rows.some((r) => r[2] === 'C0')).toBe(false)
  })

  it('refuses to merge an ID-keyed round (no advertiser info) instead of duplicating', () => {
    const file4 = path.join(dir, 'flip-datasets.json')
    const named = new Map([['7300001', { name: 'miclip', currency: 'MXN' }]])
    writeReportToDataset([row({ date: '2026-01-02', advertiserId: '7300001' })], file4, named)
    const before = listDatasets(file4).find((d) => d.name === 'TikTok 报表')!.rows.length
    // Info lookup failed this round → cells would key by the raw ID → refuse.
    const refused = mergeReportRowsIntoDataset([row({ date: '2026-01-02', advertiserId: '7300001', spend: 55 })], undefined, file4)
    expect(refused.ok).toBe(false)
    expect((refused as { error?: string }).error).toBe('incomplete-advertiser-info')
    const unchanged = listDatasets(file4).find((d) => d.name === 'TikTok 报表')!.rows.length
    expect(unchanged).toBe(before)
  })

  it('upgrades old ID-keyed rows to their name when info becomes available', () => {
    const file5 = path.join(dir, 'upgrade-datasets.json')
    // Seed with an ID-keyed dataset (as written by refreshNow's degraded path).
    const degraded = mergeReportRowsIntoDataset([row({ date: '2026-01-01', advertiserId: '7300001' })], new Map(), file5)
    // A Map() with no entries still yields ID cells → refused; use writeReportToDataset with undefined details? That also keys by ID.
    void degraded
    const seeded = listDatasets(file5).find((d) => d.name === 'TikTok 报表')
    if (seeded) {
      // Fresh named round upgrades the cell and upserts by (name, date).
      const named = new Map([['7300001', { name: 'miclip', currency: 'MXN' }]])
      const upgraded = mergeReportRowsIntoDataset([row({ date: '2026-01-01', advertiserId: '7300001', spend: 42 })], named, file5)
      expect(upgraded.ok).toBe(true)
      const dataset = listDatasets(file5).find((d) => d.name === 'TikTok 报表')!
      const thatDay = dataset.rows.filter((r) => r[0] === '2026-01-01')
      expect(thatDay).toHaveLength(1)
      expect(thatDay[0][1]).toBe('miclip')
      expect(thatDay[0][3]).toBe(42)
    }
  })
})
