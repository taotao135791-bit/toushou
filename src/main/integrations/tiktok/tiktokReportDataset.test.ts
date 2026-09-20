import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

import { DATASET_LIMITS, validateDataset } from '../../../shared/datasets'
import { BoardDataset } from '../../../shared/types'
import { listDatasets } from '../../boardDatasets'
import { TikTokReportRow, fetchIntegratedReport } from './tiktokClient'
import { reportRowsToGrid, TIKTOK_DATASET_NAME, writeReportToDataset } from './tiktokReportDataset'

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
    expect(grid.headers).toEqual(['日期', '活动名称', '消耗', '展示', '点击', '点击率', '平均点击成本', '转化', '转化成本'])
    expect(grid.rawRows[0]).toEqual(['2026-01-02', '夏日促销', '123.45', '1000', '50', '5', '2.47', '3', '41.15'])
  })

  it('maps null metrics to blank cells like a CSV export would', () => {
    const grid = reportRowsToGrid([row({ conversion: null, costPerConversion: null })])
    expect(grid.rawRows[0].slice(7)).toEqual(['', ''])
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
      'date', 'text', 'number', 'number', 'number', 'number', 'number', 'number', 'number'
    ])
    // Rows keep the client's date-desc order and number columns hold numbers.
    expect(dataset.rows[0][0]).toBe('2026-01-02')
    expect(typeof dataset.rows[0][2]).toBe('number')
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
    expect(all[0].rows[0][1]).toBe('新一轮')
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
      startDate: '2026-01-01',
      endDate: '2026-01-07'
    })
    const result = writeReportToDataset(rows, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.rows[0]).toEqual(['2026-01-02', 'C1', 10.5, 100, 5, 0.05, 2.1, 1, 10.5])
  })
})
