import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Main-owned paths resolve through electron's app.getPath.
let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
vi.mock('../tiktok/proxyFetch', () => ({ proxyFetchFor: vi.fn() }))

import { listQuerySpecs, saveQuerySpec, parseAfDataset, pullAppsFlyerDatasets, setAppsFlyerDatasetTokenSourceForTest } from './appsflyerDataset'
import { listDatasets } from '../../boardDatasets'

let dir: string
let datasetsFile: string
let specsFile: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-dataset-'))
  userDataDir = dir
  datasetsFile = path.join(dir, 'board-datasets.json')
  specsFile = path.join(dir, 'appsflyer-dataset-specs.json')
  setAppsFlyerDatasetTokenSourceForTest(() => 'token-1')
})

const DISCOVERY_TEXT = [
  '## Data: Count days activity appsflyer,Unique users days activity appsflyer,Installs appsflyer,Event name,Media source,Date,Campaign ID',
  '897,335,,App Active,tiktokglobal_int,2026-10-29,1869158348300529',
  '587,250,,App Active,tiktokglobal_int,2026-11-02,1870133414912081',
  '; ## Metadata: {"timezone":"UTC","currency":"USD","Count_days_activity_appsflyer":{"partial-data?":false},"Installs_appsflyer":{"partial-data?":false}}'
].join('\n')

const GEO_TEXT = [
  '## Data: Installs appsflyer,Active users days activity appsflyer,Geo',
  '509,2885,TH',
  '55,104,JP',
  '; ## Metadata: {"timezone":"UTC","currency":"USD","Installs_appsflyer":{"partial-data?":false}}'
].join('\n')

const EMPTY_TEXT = '## Data: ; ## Metadata: {"timezone":"UTC","currency":"USD"}'

describe('parseAfDataset (generic)', () => {
  it('maps discovery-shaped columns to localized names and types', () => {
    const parsed = parseAfDataset(DISCOVERY_TEXT)
    expect(parsed.columns.map((c) => c.name)).toEqual(['事件次数', '独立用户', '安装量', '事件', '媒体渠道', '日期', '活动ID', '时区', '币种'])
    expect(parsed.columns.find((c) => c.name === '日期')?.type).toBe('date')
    expect(parsed.columns.find((c) => c.name === '事件次数')?.type).toBe('number')
    expect(parsed.rows[0]).toEqual([897, 335, '', 'App Active', 'tiktokglobal_int', '2026-10-29', '1869158348300529', 'UTC', 'USD'])
  })

  it('parses geo-shaped answers and the one-line empty answer', () => {
    const geo = parseAfDataset(GEO_TEXT)
    expect(geo.columns.map((c) => c.name)).toEqual(['安装量', '活跃用户', '地区', '时区', '币种'])
    expect(geo.rows[0]).toEqual([509, 2885, 'TH', 'UTC', 'USD'])
    const empty = parseAfDataset(EMPTY_TEXT)
    expect(empty.rows).toHaveLength(0)
  })
})

describe('pullAppsFlyerDatasets (general queries)', () => {
  const spec = {
    id: 'afq-installs',
    name: '安装量',
    datasetName: 'AF-安装量',
    query: { app_ids: ['id1498607143'], row_count: 100, metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: 'activity' }], groupings: ['Geo'], filters: { 'Media source': ['tiktokglobal_int'] } }
  }

  it('injects dates into the recorded query and writes AF-{name}', async () => {
    saveQuerySpec(spec, specsFile)
    const seen: unknown[] = []
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' },
      file: datasetsFile,
      specsFile,
      clientFactory: () => ({
        initialize: async () => {}, queryRaw: async (input) => {
          seen.push(input)
          return DISCOVERY_TEXT
        }
      })
    })
    expect(result.ok).toBe(true)
    const written = result.results[0]
    expect(written).toMatchObject({ name: '安装量', datasetName: 'AF-安装量', ok: true })
    expect(written.rowCount).toBe(2)
    const q = (seen[0] as { query: Record<string, unknown> }).query
    expect(q.start_date).toBe('2026-10-29')
    expect(q.end_date).toBe('2026-11-04')
    expect(q.app_ids).toEqual(['id1498607143'])
    const dataset = listDatasets(datasetsFile).find((d) => d.name === 'AF-安装量')!
    expect(dataset.rows).toHaveLength(2)
  })

  it('keeps the existing dataset on an empty answer (empty ≠ zero)', async () => {
    saveQuerySpec(spec, specsFile)
    writeFileSync(datasetsFile, JSON.stringify([{
      id: 'keep-id', name: 'AF-安装量',
      columns: [{ name: '日期', type: 'date' }, { name: '安装量', type: 'number' }],
      rows: [['2026-10-20', 42]],
      createdAt: 1
    }]))
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' },
      file: datasetsFile,
      specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => EMPTY_TEXT })
    })
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, rowCount: 0 })
    const dataset = listDatasets(datasetsFile).find((d) => d.name === 'AF-安装量')!
    expect(dataset.rows).toEqual([['2026-10-20', 42]])
  })

  it('one failing spec does not block the others', async () => {
    saveQuerySpec(spec, specsFile)
    saveQuerySpec({ ...spec, id: 'afq-geo', name: 'Geo分布', datasetName: 'AF-Geo分布', query: { ...spec.query, groupings: ['Event name'] } }, specsFile)
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' },
      file: datasetsFile,
      specsFile,
      clientFactory: () => ({
        initialize: async () => {}, queryRaw: async (input) => {
          const q = (input as { query: { groupings: string[] } }).query
          if (q.groupings[0] === 'Event name') throw new Error('appsflyer-request-error (http 500)')
          return GEO_TEXT
        }
      })
    })
    expect(result.ok).toBe(false)
    expect(result.results.find((r) => r.name === '安装量')?.ok).toBe(true)
    expect(result.results.find((r) => r.name === 'Geo分布')?.error).toContain('http 500')
    expect(listDatasets(datasetsFile).find((d) => d.name === 'AF-安装量')).toBeTruthy()
  })

  it('migrates the legacy v1 spec shape into a discovery query', async () => {
    writeFileSync(specsFile, JSON.stringify([{ appId: 'id1498607143', eventName: 'App Active' }]))
    const specs = listQuerySpecs(specsFile)
    expect(specs).toHaveLength(1)
    expect(specs[0].datasetName).toBe('AppsFlyer 报表')
    expect(specs[0].query.groupings).toContain('Event name')
    expect(specs[0].query.in_app_event).toBeUndefined()
    // Persisted in the new shape after migration.
    const onDisk = JSON.parse(readFileSync(specsFile, 'utf8'))
    expect(onDisk.specs).toHaveLength(1)
  })

  it('pulls without a verified connection and fails closed', async () => {
    setAppsFlyerDatasetTokenSourceForTest(() => null)
    saveQuerySpec(spec, specsFile)
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' },
      file: datasetsFile,
      specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => DISCOVERY_TEXT })
    })
    expect(result).toMatchObject({ ok: false, error: 'not-connected' })
  })
})
