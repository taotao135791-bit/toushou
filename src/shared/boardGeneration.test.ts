import { describe, expect, it } from 'vitest'
import { checkBoardGeneration, parseBoardGenerationOptions, type BoardGenerationRecipe } from './boardGeneration'
import type { BoardDataset, BoardWidget, KanbanBoard, WidgetType } from './types'
import { boardReadingRangeDates } from './fbReading'
import { boardRefreshPlanKey, boardWidgetWindow } from './boardWindows'
import { boardWidgetDatasetBindings } from './boardDataWidgets'
import type { BoardRefreshResult } from './boardRefresh'
import { metaReadingDataset } from './metaReadingDataset'

const now = new Date(2030, 4, 14, 12).getTime()
const window = boardReadingRangeDates('last7', new Date(now))
const widget = (id: string, type: WidgetType, config: Record<string, unknown>): BoardWidget => ({ id, type, title: id, config, layout: { x: 0, y: 0, w: 3, h: 3 } })
const board = (widgets: BoardWidget[]): KanbanBoard => ({ id: 'synthetic-board', name: 'Synthetic project', createdAt: 1, updatedAt: 1, masterScope: { range: 'last7', metrics: ['spend'] }, widgets })
const nativeId = '7300000000000000099'

function fixture(): { board: KanbanBoard; datasets: BoardDataset[]; recipes: BoardGenerationRecipe[] } {
  const media: BoardDataset = {
    id: 'media-data', name: 'TikTok 报表', createdAt: 1,
    columns: [{ name: 'Date', type: 'date' }, { name: 'Campaign ID', type: 'text' }, { name: '广告主ID', type: 'text' }, { name: 'Spend', type: 'number' }, { name: 'Installs', type: 'number' }, { name: 'Currency', type: 'text' }],
    rows: [[window.start, '9000000000000000001', nativeId, 10, 4, 'USD'], [window.end, '9000000000000000002', nativeId, 20, 6, 'USD']]
  }
  const attribution: BoardDataset = {
    id: 'attribution-data', name: 'AF-Synthetic checkout', createdAt: 1,
    columns: [{ name: 'Date', type: 'date' }, { name: 'Campaign ID', type: 'text' }, { name: 'Media source', type: 'text' }, { name: 'Count', type: 'number' }, { name: 'Unique users', type: 'number' }],
    rows: [[window.start, '9000000000000000001', 'synthetic_network_int', 2, 2], [window.end, '9000000000000000002', 'synthetic_network_int', 3, 3]],
    appsflyer: { specId: 'synthetic-recipe', status: 'updated', window, dataWindow: window, attemptedAt: now }
  }
  return {
    board: board([
      widget('native-media', 'tt-reading', { advertiserIds: nativeId, range: '7' }),
      widget('spend', 'counter', { source: 'dataset', datasetId: media.id, metric: 'Spend', op: 'sum' }),
      widget('trend', 'chart-line', { source: 'dataset', datasetId: media.id, metric: 'Spend', dimension: 'Date', op: 'sum' }),
      widget('category-comparison', 'chart-bar', { source: 'dataset', datasetId: media.id, metric: 'Spend', dimension: 'Campaign ID', op: 'sum' }),
      widget('stages', 'funnel', { source: 'dataset', stages: [
        { label: 'Acquisition', datasetId: media.id, metric: 'Installs', op: 'sum' },
        { label: 'Checkout', datasetId: attribution.id, metric: 'Count', op: 'sum' }
      ] }),
      widget('facts', 'analysis', { source: 'dataset', datasetId: media.id, metric: 'Spend', dimension: 'Date', op: 'sum' }),
      widget('daily', 'table', { source: 'dataset', datasetId: media.id, columns: ['Date', 'Campaign ID', 'Spend'], pageSize: 20 })
    ]),
    datasets: [media, attribution],
    recipes: [{ id: 'synthetic-recipe', datasetId: attribution.id, datasetName: attribution.name, query: { app_ids: ['app.synthetic.store'], filters: { 'Media source': ['synthetic_network_int'] }, in_app_event: ['custom_checkout'] } }]
  }
}

describe('generated board evidence checks', () => {
  it('defaults requests to custom and validates bounded explicit requirements', () => {
    expect(parseBoardGenerationOptions({})).toEqual({ mode: 'custom' })
    expect(parseBoardGenerationOptions({ mode: 'custom', required: ['table', 'table'], daily: true })).toEqual({ mode: 'custom', required: ['table'], daily: true })
    expect(parseBoardGenerationOptions({ granularity: ['ad', 'creative', 'ad'], dimensions: ['Ad ID', 'Spend', 'Ad ID'] })).toEqual({ mode: 'custom', granularity: ['ad', 'creative'], dimensions: ['Ad ID', 'Spend'] })
    expect(parseBoardGenerationOptions({ granularity: 'account' })).toEqual({ mode: 'custom', granularity: 'account' })
    for (const value of [{ mode: 'anything' }, { required: ['made-up'] }, { required: 'data' }, { daily: 'true' }, { arbitrary: true }, { granularity: 'material' }, { granularity: [] }, { granularity: ['ad', 'made-up'] }, { dimensions: [] }, { dimensions: [''] }, { dimensions: ['Ad\nID'] }, { dimensions: Array(13).fill('Ad ID') }]) expect(parseBoardGenerationOptions(value)).toBeNull()
  })

  it('does not impose a default business board on an explicit custom snapshot', () => {
    const custom = board([widget('reference', 'counter', { source: 'manual', value: 5 }), widget('notes', 'note', { text: 'An explicitly requested reference.' })])
    const result = checkBoardGeneration(custom, [], { mode: 'custom' }, [], now)
    expect(result).toMatchObject({ status: 'ready', missing: [], issues: [], capabilities: { data: false, trend: false, funnel: false, analysis: false, 'third-party': false, table: false, refreshable: false } })
    const defaults = checkBoardGeneration(custom, [], { mode: 'default', daily: true }, [], now)
    expect(defaults.status).toBe('incomplete')
    expect(defaults.missing).toEqual(['data', 'trend', 'funnel', 'analysis', 'third-party', 'table'])
    expect(checkBoardGeneration(custom, [], { mode: 'custom', required: ['table'] }, [], now).missing).toEqual(['table'])
  })

  it('does not impose ad-platform reconciliation on a custom AF-only trend', () => {
    const f = fixture()
    const onlyAf = board([widget('attribution-trend', 'chart-line', { source: 'dataset', datasetId: 'attribution-data', metric: 'Count', dimension: 'Date', op: 'sum' })])
    const custom = checkBoardGeneration(onlyAf, f.datasets, { mode: 'custom', required: ['trend', 'third-party'] }, f.recipes, now)
    expect(custom).toMatchObject({ status: 'ready', missing: [], issues: [], capabilities: { trend: true, 'third-party': true, alignment: { status: 'not-applicable' } } })
    const defaults = checkBoardGeneration(onlyAf, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(defaults.issues.some(issue => issue.code === 'campaign-scope-unverified')).toBe(true)
  })

  it('accepts a complete live default with daily details and a legitimate categorical comparison', () => {
    const f = fixture(), result = checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now)
    expect(result).toMatchObject({ status: 'ready', missing: [], issues: [], capabilities: { data: true, trend: true, funnel: true, analysis: true, 'third-party': true, table: true, refreshable: true, dataAvailable: true, alignment: { status: 'matched-keys', matchedCampaigns: 2, mediaCampaigns: 2, attributionCampaigns: 2 } } })
    // Evidence counts preserve large IDs as strings; the report itself does not export client values.
    expect(JSON.stringify(result)).not.toContain('9000000000000000001')
    expect(JSON.stringify(result)).not.toContain('app.synthetic.store')
  })

  it('checks yesterday totals and seven-day history against their own captured query results', () => {
    const f = fixture()
    f.board.masterScope!.range = 'yesterday'
    f.board.widgets.find(item => item.id === 'trend')!.dateScope = { mode: 'lookback', days: 7, anchor: 'reportEnd' }
    f.board.widgets.push({ ...widget('attribution-history', 'chart-line', { source: 'dataset', datasetId: 'attribution-data', metric: 'Count', dimension: 'Date', op: 'sum' }), dateScope: { mode: 'lookback', days: 7, anchor: 'reportEnd' } })
    const day = boardWidgetWindow(f.board, {}, now)
    const af = f.datasets[1]
    const history = { ...af, id: 'internal-history-slot', rows: [[window.start, 'historical-campaign', 'synthetic_network_int', 2, 2], ...af.rows.slice(-1)] }
    const daily = { ...af, id: 'internal-day-slot', rows: af.rows.slice(-1), appsflyer: { ...af.appsflyer!, window: day, dataWindow: day } }
    const result: BoardRefreshResult = {
      ok: true, boardId: f.board.id, runId: 'synthetic-run', planKey: boardRefreshPlanKey(f.board), reportWindow: day, generatedAt: now, status: 'ready',
      sources: [
        { key: 'media', kind: 'tiktok', status: 'updated', window, dataset: structuredClone(f.datasets[0]), proofs: [{ advertiserId: nativeId, startDate: window.start, endDate: window.end, digest: 'a'.repeat(64) }] },
        { key: 'af-daily', kind: 'appsflyer', status: 'updated', window: day, dataset: daily },
        { key: 'af-history', kind: 'appsflyer', status: 'updated', window, dataset: history }
      ],
      widgets: f.board.widgets.map(item => ({ widgetId: item.id, window: boardWidgetWindow(f.board, item, now), status: 'updated',
        bindings: boardWidgetDatasetBindings(item).map(binding => ({ datasetId: binding.datasetId, sourceKey: binding.datasetId === af.id ? item.id === 'attribution-history' ? 'af-history' : 'af-daily' : 'media' })),
        ...(item.type === 'tt-reading' ? { nativeSourceKey: 'media' } : {}) }))
    }
    const checked = checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now, result)
    expect(checked).toMatchObject({ status: 'ready', issues: [], capabilities: { trend: true, table: true, alignment: { status: 'matched-keys', matchedCampaigns: 1, unmatchedAttributionCampaigns: 0 } } })
    // A changed shared cache cannot replace the captured, verified run.
    f.datasets[0].rows = []
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now, result).status).toBe('ready')
    const failed = structuredClone(result)
    failed.sources[1].status = 'failed'; failed.sources[1].error = 'synthetic-failure'
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now, failed).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-failed' })]))
    const changed = { ...f.board, masterScope: { ...f.board.masterScope!, range: 'today' as const } }
    expect(checkBoardGeneration(changed, f.datasets, { mode: 'default' }, f.recipes, now, result).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'refresh-run-stale' })]))
  })

  it('keeps each source calendar inside a mixed today funnel', () => {
    const f = fixture(), media = f.datasets[0], af = f.datasets[1]
    f.board.masterScope!.range = 'today'
    f.board.widgets = f.board.widgets.filter(item => ['native-media', 'stages'].includes(item.id))
    const today = boardWidgetWindow(f.board, {}, now), accountDay = { start: window.end, end: window.end }
    const accountWindows = [{ advertiserId: nativeId, startDate: accountDay.start, endDate: accountDay.end }]
    const result: BoardRefreshResult = { ok: true, boardId: f.board.id, runId: 'calendar-run', planKey: boardRefreshPlanKey(f.board), reportWindow: today, generatedAt: now, status: 'ready',
      sources: [
        { key: 'tt', kind: 'tiktok', status: 'updated', window: accountDay, dataset: { ...media, rows: media.rows.slice(-1) }, proofs: [{ advertiserId: nativeId, startDate: accountDay.start, endDate: accountDay.end, digest: 'a'.repeat(64) }] },
        { key: 'af', kind: 'appsflyer', status: 'updated', window: today, dataset: { ...af, id: 'internal-today-slot', rows: [[today.end, '9000000000000000002', 'synthetic_network_int', 3, 3]], appsflyer: { ...af.appsflyer!, window: today, dataWindow: today } } }
      ], widgets: [
        { widgetId: 'native-media', window: accountDay, accountWindows, status: 'updated', nativeSourceKey: 'tt', bindings: [] },
        { widgetId: 'stages', window: today, status: 'updated', bindings: [{ datasetId: media.id, sourceKey: 'tt', window: accountDay, accountWindows }, { datasetId: af.id, sourceKey: 'af', window: today }] }
      ] }
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', required: ['data', 'funnel', 'third-party'] }, f.recipes, now, result)).toMatchObject({ status: 'ready', issues: [] })
  })

  it('does not let demo zeros or fixed numeric widgets hide inside an otherwise complete default', () => {
    const f = fixture()
    f.board.widgets.push(widget('demo-zero', 'counter', { value: 0 }), widget('budget-demo', 'gauge', { value: 50 }), widget('clock', 'clock', { showSeconds: true }), widget('notes', 'note', { text: 'A short note.' }))
    const defaults = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(defaults.status).toBe('needs-attention')
    expect(defaults.missing).toEqual([])
    expect(defaults.issues.filter(issue => issue.code === 'manual-business-data').map(issue => issue.widgetId)).toEqual(['demo-zero', 'budget-demo'])
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom' }, f.recipes, now).status).toBe('ready')
  })

  it('does not count a category chart, placeholder points or prose as a real trend or live analysis', () => {
    const f = fixture()
    f.board.widgets = f.board.widgets.filter(item => !['trend', 'facts'].includes(item.id))
    f.board.widgets.push(widget('placeholder', 'chart-line', { points: [10, 20], labels: ['day one', 'day two'] }), widget('old-analysis', 'note', { text: 'Trend and analysis complete.' }))
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(result.missing).toEqual(['trend', 'analysis'])
    expect(result.capabilities.trend).toBe(false)
    expect(result.capabilities.analysis).toBe(false)
  })

  it('requires at least two real numeric dates rather than two campaign rows from one day', () => {
    const f = fixture()
    f.datasets[0].rows = f.datasets[0].rows.map(row => [window.end, ...row.slice(1)])
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(result).toMatchObject({ status: 'needs-attention', missing: [], capabilities: { trend: true } })
    expect(result.issues).toContainEqual({ code: 'trend-history-insufficient', widgetId: 'trend', datasetId: 'media-data' })
    f.datasets[0].rows[0][0] = window.start
    f.datasets[0].rows[0][3] = ''
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).issues.some(issue => issue.code === 'trend-history-insufficient')).toBe(true)
  })

  it('requires real metric/date/dimension/table columns and at least two bound funnel stages', () => {
    const f = fixture()
    f.board.widgets.find(item => item.id === 'trend')!.config.dimension = 'missing date'
    f.board.widgets.find(item => item.id === 'facts')!.config.dimension = 'missing dimension'
    f.board.widgets.find(item => item.id === 'daily')!.config.columns = ['not a column']
    f.board.widgets.find(item => item.id === 'stages')!.config.stages = []
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now)
    expect(result.missing).toEqual(['trend', 'funnel', 'analysis', 'third-party', 'table'])
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['trend-date-binding-missing', 'funnel-stage-binding-missing', 'dimension-missing', 'table-column-binding-missing']))
    const missingMetric = board([widget('metric', 'counter', { source: 'dataset', datasetId: 'media-data', metric: 'missing' })])
    expect(checkBoardGeneration(missingMetric, f.datasets, { mode: 'custom', required: ['data'] }, [], now)).toMatchObject({ status: 'incomplete', missing: ['data'] })
  })

  it('does not mistake a named AF import or a recipe alone for refreshable third-party data', () => {
    const f = fixture(); delete f.datasets[1].appsflyer
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(result.missing).toContain('third-party')
    expect(result.issues).toContainEqual({ code: 'query-binding-missing', widgetId: 'stages', datasetId: 'attribution-data' })
    f.datasets[1].appsflyer = { specId: 'different-recipe', status: 'updated', window, dataWindow: window, attemptedAt: now }
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).missing).toContain('third-party')
  })

  it('reports empty, failed and stale source states as attention rather than complete live results', () => {
    for (const status of ['empty', 'failed'] as const) {
      const f = fixture(); f.datasets[1].appsflyer!.status = status
      if (status === 'empty') f.datasets[1].rows = []
      const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default', daily: true }, f.recipes, now)
      expect(result.status).toBe('needs-attention')
      expect(result.missing).toEqual([])
      expect(result.issues.some(issue => issue.code === (status === 'empty' ? 'source-empty' : 'source-failed'))).toBe(true)
    }
    const f = fixture(); f.datasets[1].appsflyer!.dataWindow = { start: '2020-01-01', end: '2020-01-07' }
    const stale = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(stale.window).toEqual(window)
    expect(stale.issues).toContainEqual({ code: 'source-window-unverified', widgetId: 'stages', datasetId: 'attribution-data', expectedWindow: window, actualWindow: { start: '2020-01-01', end: '2020-01-07' } })
  })

  it('uses only the bound rows and campaign ID values for scope evidence, without guessing a brand alias', () => {
    const f = fixture()
    f.recipes[0].query!.filters = {} // Explicitly all sources is legal.
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).capabilities.alignment.status).toBe('matched-keys')
    f.datasets[1].rows = f.datasets[1].rows.map(row => [row[0], 'different-synthetic-campaign', ...row.slice(2)])
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(result.status).toBe('needs-attention')
    expect(result.capabilities.alignment).toMatchObject({ status: 'unmatched', matchedCampaigns: 0 })
    expect(result.issues).toContainEqual({ code: 'campaign-scope-unmatched' })
  })

  it('treats zero and unavailable campaign keys differently without inventing attribution matches', () => {
    const f = fixture()
    f.datasets[1].rows = [[window.end, '', 'synthetic_network_int', 0, 0]]
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now)
    expect(result.status).toBe('needs-attention')
    expect(result.missing).toEqual([])
    expect(result.capabilities.alignment.status).toBe('unknown')
    expect(result.issues.some(issue => issue.code === 'source-empty')).toBe(false)
  })

  it('rejects an absent event mapping and additive aggregation of multi-row unique users', () => {
    const f = fixture(); f.recipes[0].query!.in_app_event = []
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).issues.some(issue => issue.code === 'event-mapping-unverified')).toBe(true)
    f.recipes[0].query!.in_app_event = ['custom_checkout']
    const stages = f.board.widgets.find(item => item.id === 'stages')!.config.stages as Array<Record<string, unknown>>
    stages[1].metric = 'Unique users'
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).issues.some(issue => issue.code === 'non-additive-sum')).toBe(true)
  })

  it('checks the same ratio, missing-value and money aggregation rules used by the renderer', () => {
    const f = fixture()
    f.datasets[0].rows[1][5] = 'EUR'
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).issues.some(issue => issue.code === 'currency-mixed')).toBe(true)
    f.datasets[0].rows[1][5] = 'USD'
    f.datasets[0].rows[1][3] = ''
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'default' }, f.recipes, now).issues.some(issue => issue.code === 'metric-aggregation-unavailable')).toBe(true)
    const data: BoardDataset = { id: 'ratio-data', name: 'TikTok 报表', createdAt: 1, columns: [{ name: 'Date', type: 'date' }, { name: 'CPI', type: 'number' }, { name: 'Currency', type: 'text' }], rows: [[window.start, 3, 'USD'], [window.end, 4, 'USD']] }
    const ratio = board([widget('cost-analysis', 'analysis', { source: 'dataset', datasetId: data.id, metric: 'CPI', op: 'avg' }), widget('cost-trend', 'chart-line', { source: 'dataset', datasetId: data.id, metric: 'CPI', dimension: 'Date', op: 'avg' })])
    const result = checkBoardGeneration(ratio, [data], { mode: 'custom', required: ['analysis', 'trend'] }, [], now)
    expect(result.status).toBe('needs-attention')
    expect(result.issues.filter(issue => issue.code === 'metric-aggregation-unavailable').map(issue => issue.widgetId)).toEqual(expect.arrayContaining(['cost-analysis', 'cost-trend']))
  })

  it('does not claim that a native Meta module has fetched data that Main cannot see', () => {
    const meta = board([widget('meta-reader', 'meta-reading', { accountId: 'act_123', range: 'last7' })])
    const result = checkBoardGeneration(meta, [], { mode: 'custom', required: ['data'] }, [], now)
    expect(result).toMatchObject({ status: 'incomplete', missing: ['data'], capabilities: { dataAvailable: false, refreshable: false } })
    expect(result.issues).toContainEqual({ code: 'native-data-unverified', widgetId: 'meta-reader', datasetId: 'meta-reading:meta-reader' })
  })

  it('accepts native Meta reads and virtual rows only from the current verified refresh', () => {
    const reader = widget('meta-reader', 'meta-reading', { accountId: 'act_123', range: 'last7' })
    const meta = board([reader, widget('meta-table', 'table', { source: 'dataset', datasetId: 'meta-reading:meta-reader', columns: ['date', 'spend'] })])
    const dataset = metaReadingDataset(reader.id, { account: { id: 'act_123', name: 'Synthetic account', currency: 'USD', timezone: 'UTC' }, range: 'last7', rows: [{ date: window.start, spend: 12, impressions: 100, clicks: 3 }, { date: window.end, spend: 30, impressions: 200, clicks: 5 }], start: window.start, end: window.end, readAt: now })
    const run: BoardRefreshResult = { ok: true, boardId: meta.id, runId: 'meta-run', planKey: boardRefreshPlanKey(meta), reportWindow: window, generatedAt: now, status: 'ready', sources: [{ key: 'meta-source', kind: 'meta', status: 'updated', window, dataset }], widgets: [
      { widgetId: reader.id, window, status: 'updated', nativeSourceKey: 'meta-source', bindings: [] },
      { widgetId: 'meta-table', window, status: 'updated', bindings: [{ datasetId: dataset.id, sourceKey: 'meta-source', window }] }
    ] }
    expect(checkBoardGeneration(meta, [], { mode: 'custom', required: ['data', 'table'] }, [], now, run)).toMatchObject({ status: 'ready', issues: [], capabilities: { data: true, table: true } })
    const failed = structuredClone(run)
    failed.sources[0].status = 'failed'
    expect(checkBoardGeneration(meta, [], { mode: 'custom', required: ['data', 'table'] }, [], now, failed).status).not.toBe('ready')
  })

  it('does not silently downgrade an explicit ad-or-creative task to a campaign board', () => {
    const f = fixture()
    f.board.name = 'Ad and creative performance'
    f.board.widgets.find(item => item.id === 'daily')!.title = 'Creative ID spend and conversions'
    const options = { mode: 'custom', required: ['data', 'table'], granularity: ['ad', 'creative'] } as const
    const result = checkBoardGeneration(f.board, f.datasets, options, f.recipes, now)
    expect(result).toMatchObject({ status: 'needs-attention', missing: [], granularity: { requested: ['ad', 'creative'], displayed: ['campaign'] } })
    expect(result.issues).toContainEqual({ code: 'granularity-unverified' })
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', required: ['data', 'table'] }, f.recipes, now).status).toBe('ready')
  })

  it('accepts actual ad-ID display and grouped metrics, with exact joint requested columns', () => {
    const f = fixture(), data = f.datasets[0]
    data.columns.push({ name: '广告ID', type: 'text' })
    data.rows.forEach((row, index) => row.push(`synthetic-ad-${index + 1}`))
    f.board.widgets = [widget('ad-table', 'table', { source: 'dataset', datasetId: data.id, columns: ['广告ID', 'Spend', 'Installs'] })]
    const table = checkBoardGeneration(f.board, f.datasets, { mode: 'custom', required: ['table', 'data'], granularity: ['ad', 'creative'], dimensions: ['广告ID', 'Spend', 'Installs'] }, [], now)
    expect(table).toMatchObject({ status: 'ready', granularity: { requested: ['ad', 'creative'], displayed: ['ad'] }, dimensions: { missing: [] } })
    expect(JSON.stringify(table)).not.toContain('synthetic-ad-1')
    f.board.widgets = [widget('ad-chart', 'chart-bar', { source: 'dataset', datasetId: data.id, metric: 'Spend', dimension: '广告ID' })]
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', required: ['data'], granularity: 'ad', dimensions: ['广告ID', 'Spend'] }, [], now).status).toBe('ready')
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'creative' }, [], now).status).toBe('needs-attention')
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', dimensions: ['Ad ID'] }, [], now)).toMatchObject({ status: 'needs-attention', dimensions: { missing: ['Ad ID'] } })
  })

  it('does not count hidden dataset fields, names-only labels or a counter total as an ID breakdown', () => {
    const f = fixture(), data = f.datasets[0]
    data.columns.push({ name: 'Extra A', type: 'text' }, { name: 'Extra B', type: 'text' }, { name: 'Ad ID', type: 'text' }, { name: 'Creative name', type: 'text' })
    data.rows.forEach(row => row.push('A', 'B', 'synthetic-ad', 'Synthetic asset'))
    const options = { mode: 'custom', granularity: ['ad', 'creative'] } as const
    // The table renderer's omitted columns show only its first eight columns.
    f.board.widgets = [widget('hidden', 'table', { source: 'dataset', datasetId: data.id })]
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('needs-attention')
    f.board.widgets[0].config.columns = ['Creative name', 'Spend']
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('needs-attention')
    f.board.widgets = [widget('total', 'counter', { source: 'dataset', datasetId: data.id, metric: 'Spend' })]
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('needs-attention')
  })

  it('requires actual valid IDs in current filtered rows, rather than placeholders or rounded numbers', () => {
    const f = fixture(), data = f.datasets[0]
    data.columns.push({ name: 'Ad ID', type: 'text' })
    data.rows.forEach(row => row.push('None'))
    f.board.widgets = [widget('ad-table', 'table', { source: 'dataset', datasetId: data.id, columns: ['Ad ID', 'Spend'] })]
    for (const bad of ['None', '', '0', '000', 'unknown', 'all', '-1', 0, Number.MAX_SAFE_INTEGER + 1]) {
      data.rows.forEach(row => { row[6] = bad })
      expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'ad' }, [], now).status).toBe('needs-attention')
    }
    data.rows[0][6] = 'synthetic-ad-current'
    data.rows[1][6] = ''
    f.board.widgets[0].config.filterColumn = 'Campaign ID'
    f.board.widgets[0].config.filterValue = String(data.rows[1][1])
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'ad' }, [], now).status).toBe('needs-attention')
    f.board.widgets[0].config.filterValue = String(data.rows[0][1])
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'ad' }, [], now).status).toBe('ready')
  })

  it('treats a cleared single filter value as no filter while respecting explicit values', () => {
    const f = fixture(), data = f.datasets[0]
    f.board.widgets = [widget('table', 'table', { source: 'dataset', datasetId: data.id, columns: ['Campaign ID', 'Spend'], filterColumn: 'Campaign ID', filterValue: '' })]
    const options = { mode: 'custom', required: ['data', 'table'] } as const
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('ready')
    f.board.widgets[0].config.filterColumn = 'Removed column'
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('ready')
    f.board.widgets[0].config.filterColumn = 'Campaign ID'
    f.board.widgets[0].config.filterValues = ['nonexistent']
    expect(checkBoardGeneration(f.board, f.datasets, options, [], now).status).toBe('incomplete')
  })

  it('does not combine separate hidden grains and metric tables into a false joint breakdown', () => {
    const f = fixture(), data = f.datasets[0]
    data.columns.push({ name: 'Creative ID', type: 'text' })
    data.rows.forEach(row => row.push('synthetic-creative'))
    f.board.widgets = [
      widget('ids-only', 'table', { source: 'dataset', datasetId: data.id, columns: ['Creative ID'] }),
      widget('campaign-metrics', 'table', { source: 'dataset', datasetId: data.id, columns: ['Campaign ID', 'Spend', 'Installs'] })
    ]
    const result = checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'creative', dimensions: ['Spend', 'Installs'] }, [], now)
    expect(result.status).toBe('needs-attention')
    expect(result.issues).toContainEqual({ code: 'granularity-unverified' })
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', dimensions: ['Creative ID', 'Spend'] }, [], now).issues).toContainEqual({ code: 'dimensions-unverified' })
    f.board.widgets = [widget('incomplete-rows', 'table', { source: 'dataset', datasetId: data.id, columns: ['Creative ID', 'Spend', 'Installs'] })]
    data.rows[0][3] = ''
    data.rows[1][6] = ''
    expect(checkBoardGeneration(f.board, f.datasets, { mode: 'custom', granularity: 'creative', dimensions: ['Spend', 'Installs'] }, [], now).issues).toContainEqual({ code: 'granularity-unverified' })
  })
})
