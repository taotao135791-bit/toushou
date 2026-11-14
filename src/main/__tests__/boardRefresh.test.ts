import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/toushou-refresh-unused' } }))
import { refreshBoard, getLatestBoardRefresh, adoptBoardRefreshSnapshot, invalidateBoardRefreshSource, type BoardRefreshDeps } from '../boardRefresh'
import { boardRefreshWidgetDatasets } from '../../shared/boardRefresh'
import { buildTikTokDatasetProofPayloads } from '../../shared/tiktokDatasetProof'
import type { BoardDataset, BoardWidget, KanbanBoard } from '../../shared/types'
import type { TikTokReadingSummary } from '../../shared/tiktokReport'
import { readMetaAccounts, readMetaSummary } from '../integrations/meta/MetaBoardReader'
import type { MetaReadingAccount } from '../../shared/metaReading'

const advertiser = '7300000000000000001', now = Date.parse('2030-01-08T04:00:00Z')
const widget = (id: string, type: BoardWidget['type'], config: Record<string, unknown>): BoardWidget => ({ id, type, title: id, config, layout: { x: 0, y: 0, w: 6, h: 4 } })
function fixture() {
  const daily = widget('daily', 'counter', { source: 'dataset', datasetId: 'media', metric: '消耗', op: 'sum' })
  const trend = { ...widget('trend', 'chart-line', { ...daily.config, dimension: '日期' }), dateScope: { mode: 'lookback' as const, days: 7, anchor: 'reportEnd' as const } }
  const afDaily = widget('af-daily', 'counter', { source: 'dataset', datasetId: 'af', metric: 'Count', op: 'sum' })
  const afTrend = { ...widget('af-trend', 'chart-line', { ...afDaily.config, dimension: 'Date' }), dateScope: trend.dateScope }
  let board: KanbanBoard = { id: `board-${Math.random()}`, name: 'Synthetic daily', createdAt: 1, updatedAt: 1, masterScope: { range: 'yesterday', metrics: ['spend'] }, widgets: [daily, trend, afDaily, afTrend, widget('native', 'tt-reading', { advertiserIds: advertiser, range: 'yd' })] }
  let datasets: BoardDataset[] = [{ id: 'media', name: 'TikTok 报表', createdAt: 1, columns: [{ name: '日期', type: 'date' }, { name: '广告主ID', type: 'text' }, { name: '活动ID', type: 'text' }, { name: '活动名称', type: 'text' }, { name: '消耗', type: 'number' }, { name: '展示', type: 'number' }, { name: '点击', type: 'number' }, { name: '转化', type: 'number' }, { name: '币种', type: 'text' }], rows: [] }, { id: 'af', name: 'AF-Synthetic', createdAt: 1, columns: [{ name: 'Date', type: 'date' }, { name: 'Count', type: 'number' }], rows: [['2020-01-01', 999]], appsflyer: { specId: 'recipe', status: 'updated', window: { start: '2020-01-01', end: '2020-01-01' }, dataWindow: { start: '2020-01-01', end: '2020-01-01' }, attemptedAt: 1 } }]
  const calls = { tt: [] as unknown[], af: [] as unknown[] }
  const deps: BoardRefreshDeps = {
    now: () => now, contextKey: board.id, readBoards: () => [board], readDatasets: () => datasets,
    readSpecs: () => [{ id: 'recipe', name: 'Synthetic', datasetName: 'AF-Synthetic', datasetId: 'af', query: { app_ids: ['app.synthetic'] } }],
    readTt: async input => {
      calls.tt.push(input)
      const data = datasets[0]
      const rows: BoardDataset['rows'] = []
      for (let day = Date.parse(input.window.start); day <= Date.parse(input.window.end); day += 86_400_000) rows.push([new Date(day).toISOString().slice(0, 10), advertiser, '9100000000000000001', 'Synthetic campaign', 10, 100, 5, 2, 'USD'])
      datasets = [{ ...data, rows }, ...datasets.slice(1)]
      const proofs = buildTikTokDatasetProofPayloads(datasets[0], [{ advertiserId: advertiser, startDate: input.window.start, endDate: input.window.end }]).map(({ payload, ...window }) => ({ ...window, digest: createHash('sha256').update(payload).digest('hex') }))
      return { range: '7', startDate: input.window.start, endDate: input.window.end, generatedAt: now, source: 'oauth', advertisers: [{ advertiserId: advertiser, name: 'Synthetic', currency: 'USD' }], failed: [], mixedCurrency: false, currency: 'USD', totals: { spend: rows.length * 10, impressions: 100, clicks: 5, ctr: .05, conversions: 2, costPerConversion: 5 }, topCampaigns: [], datasetSync: { ok: true, proofs } } as TikTokReadingSummary
    },
    pullAf: async options => {
      calls.af.push(options)
      const slot = options.materializations![0], id = slot.datasetId ?? `slot-${datasets.length}`
      const data: BoardDataset = { ...datasets[1], id, name: slot.datasetName, rows: [[options.window.end, 3]], appsflyer: { specId: slot.specId, status: 'updated', window: options.window, dataWindow: options.window, attemptedAt: now, materialization: slot.materialization } }
      datasets = [...datasets.filter(item => item.id !== id), data]
      return { ok: true, results: [{ ok: true, status: 'updated', name: 'Synthetic', datasetName: data.name, datasetId: id, window: options.window, rowCount: 1 }] }
    }
  }
  return { deps, calls, board: () => board, datasets: () => datasets, setBoard: (next: KanbanBoard) => { board = next }, setDatasets: (next: BoardDataset[]) => { datasets = next } }
}
describe('Main board refresh planner', () => {
  it('resolves a legacy AF recipe by dataset name without changing the original dataset metadata', async () => {
    const f = fixture(), [, old] = f.datasets(), { appsflyer: _metadata, ...legacy } = old
    legacy.name = 'AppsFlyer 报表'
    f.setDatasets([f.datasets()[0], legacy])
    f.setBoard({ ...f.board(), widgets: [f.board().widgets.find(item => item.id === 'af-daily')!] })
    f.deps.readSpecs = () => [{ id: 'legacy-recipe', name: 'Synthetic', datasetName: 'AppsFlyer 报表', query: { app_ids: ['app.synthetic'] } }]
    const result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('ready')
    expect(result.sources).toEqual([expect.objectContaining({ kind: 'appsflyer', status: 'updated' })])
    expect(result.widgets[0].bindings[0]).toMatchObject({ datasetId: 'af', sourceKey: result.sources[0].key })
    expect(f.datasets().find(item => item.id === 'af')).toEqual(legacy)
    expect(f.calls.af[0]).toMatchObject({ materializations: [expect.objectContaining({ specId: 'legacy-recipe' })] })
    f.setBoard({ ...f.board(), masterScope: { range: 'today', metrics: ['spend'] } })
    const changed = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(changed.sources[0].window).toEqual({ start: '2030-01-08', end: '2030-01-08' })
    expect(f.calls.af).toHaveLength(2)
  })

  it('queries one TT superset and two stable AF slots without changing the original dataset', async () => {
    const f = fixture(), original = structuredClone(f.datasets()[1]), result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('ready')
    expect(f.calls.tt).toHaveLength(1)
    expect(f.calls.tt[0]).toMatchObject({ advertiserIds: advertiser, window: { start: '2030-01-01', end: '2030-01-07' } })
    expect(f.calls.af).toHaveLength(2)
    expect(f.datasets().find(data => data.id === 'af')).toEqual(original)
    const day = boardRefreshWidgetDatasets(result, f.board().widgets[0], f.datasets()).find(data => data.id === 'media')!
    const trend = boardRefreshWidgetDatasets(result, f.board().widgets[1], f.datasets()).find(data => data.id === 'media')!
    expect(day.rows).toHaveLength(1); expect(trend.rows).toHaveLength(7)
    expect(result.widgets.find(item => item.widgetId === 'native')!.ttSummary!.totals.spend).toBe(10)
    const slots = f.datasets().filter(data => data.appsflyer?.materialization).map(data => data.id)
    await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(f.datasets().filter(data => data.appsflyer?.materialization).map(data => data.id)).toEqual(slots)
    expect(getLatestBoardRefresh(f.board(), f.deps.contextKey, now + 86_400_000, f.deps.readSpecs)).toBeUndefined()
    expect(adoptBoardRefreshSnapshot(f.board(), result, 'promoted-synthetic', now, f.deps.readSpecs)).toBe(true)
    expect(getLatestBoardRefresh(f.board(), 'promoted-synthetic', now, f.deps.readSpecs)?.runId).toBe(result.runId)
    expect(adoptBoardRefreshSnapshot(f.board(), result, 'expired-synthetic', now + 86_400_000, f.deps.readSpecs)).toBe(false)
  })
  it('captures immutable TT rows and never substitutes the old AF source on failure', async () => {
    const f = fixture(); f.deps.pullAf = async () => ({ ok: false, error: 'network', results: [] })
    const result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('partial')
    expect(boardRefreshWidgetDatasets(result, f.board().widgets[2], f.datasets()).find(data => data.id === 'af')!.rows).toEqual([])
    f.setDatasets(f.datasets().map(data => data.id === 'media' ? { ...data, rows: [] } : data))
    expect(boardRefreshWidgetDatasets(result, f.board().widgets[1], f.datasets()).find(data => data.id === 'media')!.rows).toHaveLength(7)
  })
  it('rejects forged proofs and discards results when the saved request changed during the read', async () => {
    const f = fixture(), read = f.deps.readTt!
    f.deps.readTt = async (input, canCommit) => { const result = await read(input, canCommit); if (!('ok' in result) && result.datasetSync?.ok) result.datasetSync.proofs![0].digest = '0'.repeat(64); return result }
    expect((await refreshBoard({ boardId: f.board().id }, f.deps)).sources.find(source => source.kind === 'tiktok')!.error).toBe('tiktok-proof-mismatch')
    f.deps.readTt = async (input, canCommit) => { f.setBoard({ ...f.board(), masterScope: { range: 'last3', metrics: [] } }); expect(canCommit()).toBe(false); return read(input, canCommit) }
    expect((await refreshBoard({ boardId: f.board().id }, f.deps)).status).toBe('superseded')
  })
  it('keeps today and lookback on the verified account calendar and expires at its midnight', async () => {
    const f = fixture(), read = f.deps.readTt!
    f.setBoard({ ...f.board(), masterScope: { range: 'today', metrics: [] }, widgets: [...f.board().widgets, widget('mixed', 'funnel', { source: 'dataset', stages: [{ label: 'Media', source: 'dataset', datasetId: 'media', metric: '转化', op: 'sum' }, { label: 'Attribution', source: 'dataset', datasetId: 'af', metric: 'Count', op: 'sum' }] })] })
    f.deps.readTt = async (input, canCommit) => {
      expect(input.accountLookbackDays).toBe(7)
      const value = await read({ ...input, window: { start: '2030-01-01', end: '2030-01-07' } }, canCommit)
      if ('ok' in value) throw new Error('expected summary')
      value.accountWindows = [{ advertiserId: advertiser, timezone: 'America/Los_Angeles', startDate: '2030-01-01', endDate: '2030-01-07' }]
      return value
    }
    const result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('ready')
    expect(result.reportWindow).toEqual({ start: '2030-01-08', end: '2030-01-08' })
    expect(result.widgets.find(item => item.widgetId === 'daily')!.bindings[0].window).toEqual({ start: '2030-01-07', end: '2030-01-07' })
    expect(boardRefreshWidgetDatasets(result, f.board().widgets[0], f.datasets()).find(data => data.id === 'media')!.rows).toHaveLength(1)
    const mixed = boardRefreshWidgetDatasets(result, f.board().widgets.find(item => item.id === 'mixed')!, f.datasets())
    expect(mixed.find(data => data.id === 'media')!.rows[0][0]).toBe('2030-01-07')
    expect(mixed.find(data => data.id === 'af')!.rows[0][0]).toBe('2030-01-08')
    expect(getLatestBoardRefresh(f.board(), f.deps.contextKey, now, f.deps.readSpecs)).toBeDefined()
    expect(getLatestBoardRefresh(f.board(), f.deps.contextKey, now + 5 * 3_600_000, f.deps.readSpecs)).toBeUndefined()
  })
  it('isolates incompatible absolute TT windows and retains legacy name bindings by stable ID', async () => {
    const f = fixture()
    f.setBoard({ ...f.board(), widgets: f.board().widgets.filter(item => item.id === 'daily' || item.id === 'trend').map(item => item.id === 'trend' ? { ...item, dateScope: { mode: 'absolute', start: '2029-10-01', end: '2029-10-02' } } : { ...item, config: { ...item.config, datasetId: 'TikTok 报表' } }) })
    const result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('ready'); expect(f.calls.tt).toHaveLength(2)
    const projected = boardRefreshWidgetDatasets(result, f.board().widgets[0], f.datasets())
    expect(projected.filter(data => data.id === 'media')).toHaveLength(1)
    expect(projected.find(data => data.name === 'TikTok 报表')!.id).toBe('media')
    expect(projected.find(data => data.name === 'TikTok 报表')!.rows).toHaveLength(1)
  })
  it('rejects a same-ID AF event change during a query and invalidates older ready caches', async () => {
    const f = fixture(), readSpecs = f.deps.readSpecs!
    let changed = false
    f.deps.readSpecs = () => readSpecs().map(spec => ({ ...spec, query: { ...spec.query, in_app_event: [changed ? 'custom_other_event' : 'custom_original_event'] } }))
    const ready = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(ready.status).toBe('ready')
    f.deps.pullAf = async options => { changed = true; expect(options.canCommit!()).toBe(false); return { ok: false, error: 'superseded', results: [] } }
    const superseded = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(superseded.status).toBe('superseded')
    expect(getLatestBoardRefresh(f.board(), f.deps.contextKey, now, f.deps.readSpecs)).toBeUndefined()
    expect(adoptBoardRefreshSnapshot(f.board(), ready, 'outdated-query', now, f.deps.readSpecs)).toBe(false)
  })
})

describe('Main Meta board source adapter with the real structured response parser', () => {
  function metaFixture(selected = true) {
    let board: KanbanBoard = { id: `meta-synthetic-${selected}`, name: 'Synthetic Meta board', createdAt: 1, updatedAt: 1, masterScope: { range: 'last7', metrics: ['spend'] }, widgets: [widget('meta-reader', 'meta-reading', { accountId: selected ? 'act_123' : '', range: 'last7' }), widget('meta-spend', 'counter', { source: 'dataset', datasetId: 'meta-reading:meta-reader', metric: 'spend', op: 'sum' }), widget('meta-trend', 'chart-line', { source: 'dataset', datasetId: 'meta-reading:meta-reader', metric: 'spend', op: 'sum', dimension: 'date' })] }
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    let corrupt = false
    const client = { callReadTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      if (name === 'get_ad_accounts') return { structuredContent: { result: JSON.stringify({ data: [{ id: 'act_123', name: 'Synthetic Meta account', currency: 'USD', timezone_name: 'UTC' }] }) } }
      const range = args.time_range as { since: string; until: string }
      return { structuredContent: { result: JSON.stringify({ object_id: 'act_123', level: 'account', time_breakdown: 'day', time_range: range, total_segments: 2, segmented_metrics: [range.since, range.until].map((day, index) => ({ period_start: day, period_end: day, metrics: { account_id: corrupt ? '999' : '123', date_start: day, date_stop: day, spend: String((index + 1) * 10), impressions: '100', ...(index ? {} : { clicks: '5' }) } })) }) } }
    } }
    const deps: BoardRefreshDeps = { contextKey: board.id, now: () => now, readBoards: () => [board], readDatasets: () => [], readSpecs: () => [], readMeta: async input => {
      const accounts = await readMetaAccounts(client)
      if (input.action === 'accounts') return { ok: true, data: accounts }
      const account = accounts.accounts.find(account => account.id === input.accountId) as MetaReadingAccount
      return { ok: true, data: await readMetaSummary(client, account, input.range, input.window) }
    } }
    return { deps, calls, board: () => board, select: () => { board = { ...board, widgets: board.widgets.map(item => item.type === 'meta-reading' ? { ...item, config: { ...item.config, accountId: 'act_123' } } : item) } }, independentRange: () => { board = { ...board, widgets: board.widgets.map(item => item.type === 'meta-reading' ? { ...item, config: { ...item.config, independent: true, range: 'last3' } } : item) } }, corrupt: () => { corrupt = true } }
  }
  it('serves a selected native reader and linked KPI/trend from one verified Meta read', async () => {
    const f = metaFixture(), result = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(result.status).toBe('ready'); expect(result.sources).toHaveLength(1)
    expect(f.calls.filter(call => call.name === 'get_insights')).toHaveLength(1)
    expect(f.calls.find(call => call.name === 'get_insights')!.args.time_range).toEqual({ since: '2030-01-01', until: '2030-01-07' })
    expect(result.sources[0]).toMatchObject({ kind: 'meta', status: 'updated', dataset: { id: 'meta-reading:meta-reader' } })
    const projected = boardRefreshWidgetDatasets(result, f.board().widgets[1])
    expect(projected[0].columns.map(column => column.name)).toEqual(['date', 'account', 'account_id', 'currency', 'spend', 'impressions'])
    expect(projected[0].rows.map(row => row[4])).toEqual([10, 20])
    expect(result.widgets.find(view => view.widgetId === 'meta-reader')!.metaSummary!.account.id).toBe('act_123')
    f.independentRange()
    const independent = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(independent.status).toBe('ready')
    expect(independent.sources).toHaveLength(1)
    expect(independent.sources[0].window).toEqual({ start: '2030-01-05', end: '2030-01-07' })
    expect(independent.widgets.find(view => view.widgetId === 'meta-spend')!.bindings[0].window).toEqual(independent.sources[0].window)
    invalidateBoardRefreshSource('meta')
    expect(getLatestBoardRefresh(f.board(), f.deps.contextKey, now)).toBeUndefined()
  })
  it('returns authorized choices without guessing an account, then succeeds after selection and masks invalid rows', async () => {
    const f = metaFixture(false)
    const pending = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(pending.status).toBe('failed')
    expect(pending.sources[0]).toMatchObject({ status: 'unbound', error: 'source-selection-required' })
    expect(pending.widgets.find(view => view.widgetId === 'meta-reader')!.metaAccounts).toEqual([{ id: 'act_123', name: 'Synthetic Meta account', currency: 'USD', timezone: 'UTC' }])
    expect(f.board().widgets[0].config.accountId).toBe('')
    expect(f.calls.some(call => call.name === 'get_insights')).toBe(false)
    f.select()
    expect((await refreshBoard({ boardId: f.board().id }, f.deps)).status).toBe('ready')
    f.corrupt()
    const failed = await refreshBoard({ boardId: f.board().id }, f.deps)
    expect(failed.sources[0].status).toBe('failed')
    expect(failed.sources[0].dataset).toBeUndefined()
    expect(boardRefreshWidgetDatasets(failed, f.board().widgets[1])).toEqual([])
  })
})
