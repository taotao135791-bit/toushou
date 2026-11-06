import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Main-owned paths resolve through electron's app.getPath.
let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))
vi.mock('../tiktok/proxyFetch', () => ({ proxyFetchFor: vi.fn() }))

import { listQuerySpecs, saveQuerySpec, parseAfDataset, pullAppsFlyerDatasets, setAppsFlyerDatasetTokenSourceForTest } from './appsflyerDataset'
import { createOrUpdateDataset, listDatasets, renameDataset } from '../../boardDatasets'

let dir: string
let datasetsFile: string
let specsFile: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-dataset-'))
  userDataDir = dir
  datasetsFile = path.join(dir, 'board-datasets.json')
  specsFile = path.join(dir, 'appsflyer-dataset-specs.json')
  setAppsFlyerDatasetTokenSourceForTest(() => 'synthetic-access-token')
})

// Entirely invented identifiers and readings; never copy real reports here.
const DISCOVERY_TEXT = [
  '## Data: Count days activity appsflyer,Unique users days activity appsflyer,Installs appsflyer,Event name,Media source,Date,Campaign ID',
  '100,25,,App Active,tiktokglobal_int,2026-10-29,synthetic-campaign-a',
  '60,20,,App Active,tiktokglobal_int,2026-11-02,synthetic-campaign-b',
  '; ## Metadata: {"timezone":"UTC","currency":"USD","Count_days_activity_appsflyer":{"partial-data?":false},"Installs_appsflyer":{"partial-data?":false}}'
].join('\n')

const GEO_TEXT = [
  '## Data: Installs appsflyer,Active users days activity appsflyer,Geo',
  '2,12,US',
  '1,4,GB',
  '; ## Metadata: {"timezone":"UTC","currency":"USD","Installs_appsflyer":{"partial-data?":false}}'
].join('\n')

const EMPTY_TEXT = '## Data: ; ## Metadata: {"timezone":"UTC","currency":"USD"}'

describe('parseAfDataset (generic)', () => {
  it('maps discovery-shaped columns to localized names and types', () => {
    const parsed = parseAfDataset(DISCOVERY_TEXT)
    expect(parsed.columns.map((c) => c.name)).toEqual(['事件次数', '独立用户', '安装量', '事件', '媒体渠道', '日期', '活动ID', '时区', '币种'])
    expect(parsed.columns.find((c) => c.name === '日期')?.type).toBe('date')
    expect(parsed.columns.find((c) => c.name === '事件次数')?.type).toBe('number')
    expect(parsed.rows[0]).toEqual([100, 25, '', 'App Active', 'tiktokglobal_int', '2026-10-29', 'synthetic-campaign-a', 'UTC', 'USD'])
  })

  it('parses geo-shaped answers and the one-line empty answer', () => {
    const geo = parseAfDataset(GEO_TEXT)
    expect(geo.columns.map((c) => c.name)).toEqual(['安装量', '活跃用户', '地区', '时区', '币种'])
    expect(geo.rows[0]).toEqual([2, 12, 'US', 'UTC', 'USD'])
    const empty = parseAfDataset(EMPTY_TEXT)
    expect(empty.rows).toHaveLength(0)
  })

  it('rejects explicit partial/truncated metadata and responses reaching the requested row limit', () => {
    expect(() => parseAfDataset(GEO_TEXT.replace('"partial-data?":false', '"partial-data?":true'))).toThrow('appsflyer-incomplete-data')
    expect(() => parseAfDataset(GEO_TEXT.replace('"timezone":"UTC"', '"truncated":true,"timezone":"UTC"'))).toThrow('appsflyer-incomplete-data')
    expect(() => parseAfDataset(GEO_TEXT, 2)).toThrow('appsflyer-incomplete-data')
    expect(() => parseAfDataset(EMPTY_TEXT.replace('"timezone":"UTC"', '"partial-data?":true,"timezone":"UTC"'))).toThrow('appsflyer-incomplete-data')
  })
})

describe('pullAppsFlyerDatasets (general queries)', () => {
  const spec = {
    id: 'afq-installs',
    name: '安装量',
    datasetName: 'AF-安装量',
    query: { app_ids: ['app.synthetic.install-a'], row_count: 100, metrics: [{ metric_name: 'Count', attribution_source: 'appsflyer', period: 'activity' }], groupings: ['Geo'], filters: { 'Media source': ['tiktokglobal_int'] } }
  }

  it('refreshes a materialized board window when all 20 user dataset slots are occupied', async () => {
    saveQuerySpec(spec, specsFile)
    const factory = () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    await pullAppsFlyerDatasets({ window: { start: '2026-11-05', end: '2026-11-05' }, specIds: [spec.id], file: datasetsFile, specsFile, clientFactory: factory })
    const original = listDatasets(datasetsFile)[0]
    for (let index = 0; index < 19; index++) expect(createOrUpdateDataset(`Synthetic base ${index}`, { columns: [{ name: 'n', type: 'number' }], rows: [[index]], truncated: false }, datasetsFile).ok).toBe(true)
    const base = listDatasets(datasetsFile), recipe = listQuerySpecs(specsFile)[0]
    expect(base).toHaveLength(20)
    const slot = { specId: spec.id, datasetName: 'AF-Synthetic isolated slot', materialization: { boardId: 'synthetic-owner', bindingDatasetId: original.id, scopeKey: '{"mode":"inherit"}' } }
    const first = await pullAppsFlyerDatasets({ window: { start: '2026-11-06', end: '2026-11-06' }, materializations: [slot], file: datasetsFile, specsFile, clientFactory: factory })
    expect(first.ok).toBe(true)
    const id = first.results[0].datasetId!
    expect(await pullAppsFlyerDatasets({ window: { start: '2026-11-07', end: '2026-11-07' }, materializations: [{ ...slot, datasetId: id }], file: datasetsFile, specsFile, clientFactory: factory })).toMatchObject({ ok: true, results: [{ datasetId: id, status: 'updated' }] })
    expect(listDatasets(datasetsFile).filter(dataset => !dataset.appsflyer?.materialization)).toEqual(base)
    expect(listDatasets(datasetsFile)).toHaveLength(21)
    expect(listQuerySpecs(specsFile)[0]).toEqual(recipe)
  })

  it('reuses a logical recipe in isolated daily/trend slots without redirecting the original binding', async () => {
    saveQuerySpec(spec, specsFile)
    const factory = () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    await pullAppsFlyerDatasets({ window: { start: '2026-10-29', end: '2026-11-04' }, specIds: [spec.id], file: datasetsFile, specsFile, clientFactory: factory })
    const original = listDatasets(datasetsFile)[0], recipe = listQuerySpecs(specsFile)[0]
    const slot = { specId: spec.id, datasetName: 'AF-Synthetic daily slot', materialization: { boardId: 'synthetic-board', bindingDatasetId: original.id, scopeKey: '{"mode":"inherit"}' } }
    const first = await pullAppsFlyerDatasets({ window: { start: '2026-11-05', end: '2026-11-05' }, materializations: [slot], file: datasetsFile, specsFile, clientFactory: factory })
    const id = first.results[0].datasetId!
    await pullAppsFlyerDatasets({ window: { start: '2026-11-06', end: '2026-11-06' }, materializations: [{ ...slot, datasetId: id }], file: datasetsFile, specsFile, clientFactory: factory })
    expect(listDatasets(datasetsFile)).toHaveLength(2)
    expect(listDatasets(datasetsFile).find(data => data.id === original.id)).toEqual(original)
    expect(listDatasets(datasetsFile).find(data => data.id === id)!.appsflyer).toMatchObject({ specId: spec.id, window: { start: '2026-11-06', end: '2026-11-06' }, materialization: slot.materialization })
    expect(listQuerySpecs(specsFile)[0]).toEqual(recipe)
    const before = readFileSync(datasetsFile, 'utf8')
    await pullAppsFlyerDatasets({ window: { start: '2026-11-07', end: '2026-11-07' }, materializations: [{ ...slot, datasetId: id }], canCommit: () => false, file: datasetsFile, specsFile, clientFactory: factory })
    expect(readFileSync(datasetsFile, 'utf8')).toBe(before)
  })
  it('keeps copied dataset identities in separate profile stores from superseding each other', async () => {
    saveQuerySpec(spec, specsFile)
    const factory = () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    await pullAppsFlyerDatasets({ window: { start: '2026-11-04', end: '2026-11-04' }, file: datasetsFile, specsFile, clientFactory: factory })
    const copiedFile = path.join(dir, 'draft-datasets.json')
    writeFileSync(copiedFile, readFileSync(datasetsFile, 'utf8'))
    let release!: (text: string) => void, started!: () => void
    const pending = new Promise<string>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
    const old = pullAppsFlyerDatasets({ window: { start: '2026-11-05', end: '2026-11-05' }, file: datasetsFile, specsFile, clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => { started(); return pending } }) })
    await began
    await pullAppsFlyerDatasets({ window: { start: '2026-11-06', end: '2026-11-06' }, file: copiedFile, specsFile, clientFactory: factory })
    release(GEO_TEXT)
    expect((await old).results[0].status).toBe('updated')
    expect(listDatasets(datasetsFile)[0].appsflyer!.window.end).toBe('2026-11-05')
    expect(listDatasets(copiedFile)[0].appsflyer!.window.end).toBe('2026-11-06')
  })

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
    expect(q.app_ids).toEqual(['app.synthetic.install-a'])
    const dataset = listDatasets(datasetsFile).find((d) => d.name === 'AF-安装量')!
    expect(dataset.rows).toHaveLength(2)
  })

  it('clears previous rows on an empty answer and records the exact empty window', async () => {
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
    expect(result.results[0]).toMatchObject({ ok: true, status: 'empty', rowCount: 0, datasetId: 'keep-id' })
    const dataset = listDatasets(datasetsFile).find((d) => d.name === 'AF-安装量')!
    expect(dataset.rows).toEqual([])
    expect(dataset.columns).toEqual([{ name: '日期', type: 'date' }, { name: '安装量', type: 'number' }])
    expect(dataset.appsflyer).toMatchObject({ status: 'empty', window: { start: '2026-10-29', end: '2026-11-04' }, dataWindow: { start: '2026-10-29', end: '2026-11-04' } })
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

  it('creates a bindable dataset and recipe identity even when the first query is empty', async () => {
    saveQuerySpec(spec, specsFile)
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' }, file: datasetsFile, specsFile,
      specIds: [spec.id], clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => EMPTY_TEXT })
    })
    expect(result.ok).toBe(true)
    const dataset = listDatasets(datasetsFile)[0]
    expect(dataset.columns).toEqual([{ name: '事件次数', type: 'number' }, { name: '地区', type: 'text' }])
    expect(dataset.rows).toEqual([])
    expect(result.results[0]).toMatchObject({ datasetId: dataset.id, status: 'empty' })
    expect(listQuerySpecs(specsFile)[0].datasetId).toBe(dataset.id)
  })

  it('refreshes only requested bindings and follows dataset identity after a rename', async () => {
    saveQuerySpec(spec, specsFile)
    saveQuerySpec({ ...spec, id: 'other-spec', name: 'Other', datasetName: 'AF-Other' }, specsFile)
    const initial = await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' }, file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    })
    expect(initial.ok).toBe(true)
    const selected = listDatasets(datasetsFile).find(item => item.name === spec.datasetName)!
    const other = listDatasets(datasetsFile).find(item => item.name === 'AF-Other')!
    renameDataset(selected.id, 'AF-Renamed', datasetsFile)
    const queryRaw = vi.fn(async () => DISCOVERY_TEXT)
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-11-05', end: '2026-11-05' }, file: datasetsFile, specsFile,
      datasetIds: [selected.id], clientFactory: () => ({ initialize: async () => {}, queryRaw })
    })
    expect(result.ok).toBe(true)
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(listDatasets(datasetsFile).find(item => item.id === selected.id)?.name).toBe('AF-Renamed')
    expect(listQuerySpecs(specsFile).find(item => item.id === spec.id)?.datasetName).toBe('AF-Renamed')
    expect(listDatasets(datasetsFile).find(item => item.id === other.id)).toEqual(other)
  })

  it('reports an imported AF dataset without a recipe rather than pulling unrelated recipes', async () => {
    saveQuerySpec(spec, specsFile)
    writeFileSync(datasetsFile, JSON.stringify([{
      id: 'imported-funnel', name: 'AF-Imported funnel', createdAt: 1,
      columns: [{ name: '人数', type: 'number' }], rows: [[42]]
    }]))
    const factory = vi.fn()
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-11-05', end: '2026-11-05' }, datasetIds: ['imported-funnel'],
      file: datasetsFile, specsFile, clientFactory: factory
    })
    expect(factory).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'missing-query', results: [{ datasetId: 'imported-funnel', status: 'unbound', error: 'missing-query' }] })
    expect(listDatasets(datasetsFile)[0]).toMatchObject({ rows: [[42]], appsflyer: { status: 'unbound', window: { start: '2026-11-05', end: '2026-11-05' } } })
  })

  it('persists failure without relabeling old rows as the new window', async () => {
    saveQuerySpec(spec, specsFile)
    const firstWindow = { start: '2026-10-29', end: '2026-11-04' }
    await pullAppsFlyerDatasets({
      window: firstWindow, file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    })
    const existing = listDatasets(datasetsFile)[0]
    const latestWindow = { start: '2026-11-05', end: '2026-11-05' }
    const result = await pullAppsFlyerDatasets({
      window: latestWindow, datasetIds: [existing.id], file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => { throw new Error('synthetic failure') } })
    })
    expect(result.results[0]).toMatchObject({ ok: false, status: 'failed' })
    expect(listDatasets(datasetsFile)[0]).toMatchObject({ rows: existing.rows, appsflyer: { status: 'failed', dataWindow: firstWindow, window: latestWindow } })
  })

  it('does not let a slower old-window query overwrite a newer refresh', async () => {
    saveQuerySpec(spec, specsFile)
    await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' }, file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    })
    const datasetId = listDatasets(datasetsFile)[0].id
    let releaseOld!: (text: string) => void
    let oldStarted!: () => void
    const started = new Promise<void>(resolve => { oldStarted = resolve })
    const pending = new Promise<string>(resolve => { releaseOld = resolve })
    const old = pullAppsFlyerDatasets({
      window: { start: '2026-11-04', end: '2026-11-04' }, datasetIds: [datasetId], file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => { oldStarted(); return pending } })
    })
    await started
    const newWindow = { start: '2026-11-05', end: '2026-11-05' }
    await pullAppsFlyerDatasets({
      window: newWindow, datasetIds: [datasetId], file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => EMPTY_TEXT })
    })
    releaseOld(DISCOVERY_TEXT)
    expect((await old).results[0].status).toBe('superseded')
    expect(listDatasets(datasetsFile)[0]).toMatchObject({ rows: [], appsflyer: { status: 'empty', dataWindow: newWindow } })
  })

  it('rejects a same-name recipe for another app rather than overwriting its existing dataset', async () => {
    saveQuerySpec(spec, specsFile)
    await pullAppsFlyerDatasets({
      window: { start: '2026-10-29', end: '2026-11-04' }, specIds: [spec.id], file: datasetsFile, specsFile,
      clientFactory: () => ({ initialize: async () => {}, queryRaw: async () => GEO_TEXT })
    })
    const original = listDatasets(datasetsFile)[0]
    saveQuerySpec({ ...spec, id: 'another-app-spec', query: { ...spec.query, app_ids: ['app.synthetic.install-b'] } }, specsFile)
    const factory = vi.fn()
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-11-05', end: '2026-11-05' }, specIds: ['another-app-spec'], file: datasetsFile, specsFile, clientFactory: factory
    })
    expect(factory).not.toHaveBeenCalled()
    expect(result.results[0]).toMatchObject({ ok: false, error: 'dataset-name-conflict' })
    expect(listDatasets(datasetsFile)[0]).toEqual(original)
  })

  it('does not fall back to a replacement with the same name after a bound dataset was deleted', async () => {
    saveQuerySpec({ ...spec, datasetId: 'deleted-dataset-id' }, specsFile)
    const replacement = {
      id: 'replacement-dataset-id', name: spec.datasetName, createdAt: 2,
      columns: [{ name: '安装量', type: 'number' }], rows: [[42]]
    }
    writeFileSync(datasetsFile, JSON.stringify([replacement]))
    const before = readFileSync(datasetsFile, 'utf8')
    const factory = vi.fn()
    const result = await pullAppsFlyerDatasets({
      window: { start: '2026-11-05', end: '2026-11-05' }, specIds: [spec.id],
      file: datasetsFile, specsFile, clientFactory: factory
    })
    expect(factory).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'not-found', results: [{ datasetId: 'deleted-dataset-id', status: 'unbound', error: 'not-found' }] })
    expect(readFileSync(datasetsFile, 'utf8')).toBe(before)
    expect(listQuerySpecs(specsFile)[0].datasetId).toBe('deleted-dataset-id')
  })

  it('migrates the legacy v1 spec shape into a discovery query', async () => {
    writeFileSync(specsFile, JSON.stringify([{ appId: 'app.synthetic.install-a', eventName: 'App Active' }]))
    const specs = listQuerySpecs(specsFile)
    expect(specs).toHaveLength(1)
    expect(specs[0].datasetName).toBe('AppsFlyer 报表')
    expect(specs[0].query.groupings).toContain('Event name')
    expect(specs[0].query.in_app_event).toBeUndefined()
    // Persisted in the new shape after migration.
    const onDisk = JSON.parse(readFileSync(specsFile, 'utf8'))
    expect(onDisk.specs).toHaveLength(1)
  })

  it('inspects a legacy recipe without writing a migration during a read-only check', () => {
    const legacy = JSON.stringify([{ appId: 'app.synthetic.readonly', eventName: 'custom_checkout' }])
    writeFileSync(specsFile, legacy)
    expect(listQuerySpecs(specsFile, { persistMigration: false })[0].query.in_app_event).toEqual(['custom_checkout'])
    expect(readFileSync(specsFile, 'utf8')).toBe(legacy)
  })

  it('preserves every existing live recipe when capacity is reached and still allows updates', () => {
    for (let i = 0; i < 20; i++) saveQuerySpec({ ...spec, id: `synthetic-query-${i}`, name: `Synthetic ${i}`, datasetName: `AF-Synthetic ${i}` }, specsFile)
    const before = readFileSync(specsFile, 'utf8')
    expect(() => saveQuerySpec({ ...spec, id: 'one-more-synthetic-query' }, specsFile)).toThrow('query-limit')
    expect(readFileSync(specsFile, 'utf8')).toBe(before)
    saveQuerySpec({ ...spec, id: 'synthetic-query-0', name: 'Updated synthetic' }, specsFile)
    const stored = listQuerySpecs(specsFile)
    expect(stored).toHaveLength(20)
    expect(stored.find(query => query.id === 'synthetic-query-0')?.name).toBe('Updated synthetic')
    expect(stored.some(query => query.id === 'synthetic-query-1')).toBe(true)
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
