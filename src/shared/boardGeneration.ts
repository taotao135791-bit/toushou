import type { BoardDataset, BoardWidget, KanbanBoard } from './types'
import { boardWidgetDatasetBindings, type BoardDataBinding } from './boardDataWidgets'
import { boardReadingRangeDates } from './fbReading'
import { filterDatasetRowsByWindowWithStatus } from './datasets'
import { metricCurrencySafety, safeMetricGroups, safeMetricValue } from './boardMetricSafety'
import { boardRefreshPlanKey, boardWidgetWindow } from './boardWindows'
import { boardRefreshWidgetDatasets, type BoardRefreshResult } from './boardRefresh'

export const BOARD_GENERATION_CAPABILITIES = ['data', 'trend', 'funnel', 'analysis', 'third-party', 'table'] as const
export type BoardGenerationCapability = typeof BOARD_GENERATION_CAPABILITIES[number]
export const BOARD_GENERATION_GRANULARITIES = ['account', 'campaign', 'adgroup', 'ad', 'creative'] as const
export type BoardGenerationGranularity = typeof BOARD_GENERATION_GRANULARITIES[number]
export interface BoardGenerationOptions {
  mode: 'default' | 'custom'
  required?: readonly BoardGenerationCapability[]
  daily?: boolean
  /** Explicit task grain. Several acceptable grains mean OR, never an automatic fallback to a coarser grain. */
  granularity?: BoardGenerationGranularity | readonly BoardGenerationGranularity[]
  /** Exact fields that must be shown together, rather than merely stored in a hidden dataset. */
  dimensions?: readonly string[]
}
export interface BoardGenerationRecipe { id: string; datasetId?: string; datasetName?: string; query?: Record<string, unknown> }
export interface BoardGenerationIssue { code: string; widgetId?: string; datasetId?: string; expectedWindow?: { start: string; end: string }; actualWindow?: { start: string; end: string } }
export interface BoardGenerationAlignment {
  status: 'matched-keys' | 'unknown' | 'unmatched' | 'not-applicable'
  matchedCampaigns: number
  mediaCampaigns: number
  attributionCampaigns: number
  unmatchedMediaCampaigns: number
  unmatchedAttributionCampaigns: number
}
export interface BoardGenerationCheck {
  status: 'ready' | 'incomplete' | 'needs-attention'
  missing: BoardGenerationCapability[]
  issues: BoardGenerationIssue[]
  /** Exact requested dates: callers should reuse them rather than recalculate a relative range. */
  window?: { start: string; end: string }
  granularity?: { requested: BoardGenerationGranularity[]; displayed: BoardGenerationGranularity[] }
  dimensions?: { requested: string[]; missing: string[]; displayedTogether: boolean }
  capabilities: Record<BoardGenerationCapability, boolean> & { refreshable: boolean; dataAvailable: boolean; alignment: BoardGenerationAlignment }
}

type Row = BoardDataset['rows'][number]
type BindingCheck = { valid: boolean; live: boolean; attribution: boolean; media: boolean; reportScope: boolean; dataset?: BoardDataset; rows: Row[]; issues: BoardGenerationIssue[] }
type DisplayProjection = { dataset: BoardDataset; rows: Row[]; columns: string[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v)
const key = (v: string) => v.trim().toLowerCase().replace(/[\s_-]/g, '')
const campaignKeys = new Set(['活动id', '广告系列id', 'campaignid'])
const granularityKeys: Record<BoardGenerationGranularity, ReadonlySet<string>> = {
  account: new Set(['accountid', 'adaccountid', 'advertiserid', '账户id', '广告账户id', '广告主id']),
  campaign: campaignKeys,
  adgroup: new Set(['adgroupid', 'adsetid', '广告组id', '广告集id']),
  ad: new Set(['adid', '广告id']),
  creative: new Set(['creativeid', 'materialid', 'assetid', '素材id', '创意id'])
}
const eventKeys = new Set(['事件', '事件名', 'event', 'eventname'])
const sourceKeys = new Set(['媒体渠道', 'mediasource'])
const eventMetrics = new Set(['count', 'uniqueusers', '事件次数', '独立用户'])
const uniqueMetrics = new Set(['uniqueusers', 'distinctusers', 'activeusers', '独立用户', '去重用户', '活跃用户'])
const truth = (v: unknown): v is string => text(v) && !['none', 'null', 'n/a', '-', 'unknown'].includes(v.trim().toLowerCase())
// Large platform IDs must remain strings; rounded numeric IDs cannot prove a grain.
const validId = (v: unknown) => typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : truth(v) && !/^0+$/.test(v.trim()) && !/^[+-]|^\d+\.\d+$/.test(v.trim()) && !['all', 'undefined', '—'].includes(v.trim().toLowerCase())
const hasValue = (v: unknown) => typeof v === 'number' ? Number.isFinite(v) : truth(v)

/** Request validation is shared with Main; an omitted mode never opts into the default layout. */
export function parseBoardGenerationOptions(raw: unknown): BoardGenerationOptions | null {
  if (!object(raw) || Object.keys(raw).some(k => !['mode', 'required', 'daily', 'granularity', 'dimensions'].includes(k))) return null
  const mode = raw.mode ?? 'custom'
  if (mode !== 'default' && mode !== 'custom') return null
  if (raw.daily !== undefined && typeof raw.daily !== 'boolean') return null
  if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.length > BOARD_GENERATION_CAPABILITIES.length || raw.required.some(v => !BOARD_GENERATION_CAPABILITIES.includes(v as BoardGenerationCapability)))) return null
  if (raw.granularity !== undefined && (Array.isArray(raw.granularity) ? !raw.granularity.length || raw.granularity.length > BOARD_GENERATION_GRANULARITIES.length || raw.granularity.some(v => !BOARD_GENERATION_GRANULARITIES.includes(v as BoardGenerationGranularity)) : !BOARD_GENERATION_GRANULARITIES.includes(raw.granularity as BoardGenerationGranularity))) return null
  if (raw.dimensions !== undefined && (!Array.isArray(raw.dimensions) || !raw.dimensions.length || raw.dimensions.length > 12 || raw.dimensions.some(value => !text(value)))) return null
  return {
    mode,
    ...(Array.isArray(raw.required) ? { required: [...new Set(raw.required as BoardGenerationCapability[])] } : {}),
    ...(typeof raw.daily === 'boolean' ? { daily: raw.daily } : {}),
    ...(raw.granularity !== undefined ? { granularity: Array.isArray(raw.granularity) ? [...new Set(raw.granularity as BoardGenerationGranularity[])] : raw.granularity as BoardGenerationGranularity } : {}),
    ...(Array.isArray(raw.dimensions) ? { dimensions: [...new Set(raw.dimensions as string[])] } : {})
  }
}

function masterWindow(board: KanbanBoard, now: number): { start: string; end: string } | undefined {
  if (!board.masterScope) return undefined
  if (board.masterScope.range !== 'yesterday') return boardReadingRangeDates(board.masterScope.range, new Date(now))
  const day = new Date(now)
  day.setDate(day.getDate() - 1)
  const value = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  return { start: value, end: value }
}

/** Checks saved structure and visible source evidence; it never queries or modifies a board. */
export function checkBoardGeneration(
  board: KanbanBoard,
  datasets: readonly BoardDataset[],
  options: BoardGenerationOptions = { mode: 'custom' },
  recipes: readonly BoardGenerationRecipe[] = [],
  now = Date.now(),
  refreshResult?: BoardRefreshResult
): BoardGenerationCheck {
  const required = new Set<BoardGenerationCapability>(options.mode === 'default' ? ['data', 'trend', 'funnel', 'analysis', 'third-party'] : [])
  options.required?.forEach(capability => required.add(capability))
  if (options.daily) required.add('table')
  const found = Object.fromEntries(BOARD_GENERATION_CAPABILITIES.map(capability => [capability, false])) as Record<BoardGenerationCapability, boolean>
  const issues: BoardGenerationIssue[] = []
  const sourceChecks: BindingCheck[] = []
  const projections: DisplayProjection[] = []
  const window = masterWindow(board, now)
  const currentRun = refreshResult?.boardId === board.id && refreshResult.planKey === boardRefreshPlanKey(board) && refreshResult.status !== 'superseded' && (!window || (refreshResult.reportWindow.start === window.start && refreshResult.reportWindow.end === window.end)) ? refreshResult : undefined
  if (refreshResult && !currentRun && [...required].some(capability => ['data', 'trend', 'funnel', 'analysis', 'third-party'].includes(capability))) issues.push({ code: 'refresh-run-stale' })
  const allTtIds = board.widgets.filter(widget => widget.type === 'tt-reading').flatMap(widget => typeof widget.config.advertiserIds === 'string' ? widget.config.advertiserIds.split(/[,，;；\s]+/).filter(Boolean) : [])
  const addIssues = (caps: BoardGenerationCapability[], list: BoardGenerationIssue[]) => { if (caps.some(capability => required.has(capability))) issues.push(...list) }

  const inspect = (widget: BoardWidget, binding: BoardDataBinding): BindingCheck => {
    const view = currentRun?.widgets.find(item => item.widgetId === widget.id)
    const runBinding = view?.bindings.find(item => item.datasetId === binding.datasetId)
    const sourceKey = runBinding?.sourceKey ?? view?.nativeSourceKey
    const source = currentRun?.sources.find(item => item.key === sourceKey)
    const scopedDatasets = currentRun ? boardRefreshWidgetDatasets(currentRun, widget, [...datasets]) : datasets
    const original = datasets.find(item => item.id === binding.datasetId) ?? datasets.find(item => item.name === binding.datasetId)
    const native = widget.type === 'tt-reading' || widget.type === 'meta-reading'
    const dataset = native && source?.dataset ? { ...source.dataset, id: original?.id ?? source.dataset.id, name: original?.name ?? source.dataset.name } : scopedDatasets.find(item => item.id === binding.datasetId) ?? scopedDatasets.find(item => item.name === binding.datasetId)
    const requestedWindow = board.masterScope || widget.dateScope ? boardWidgetWindow(board, widget, now) : undefined
    // Today can be a different calendar day per media account. The trusted
    // refresh projection already selects that account's actual stat window.
    const accountWindows = runBinding?.accountWindows ?? (native ? view?.accountWindows : undefined)
    const effectiveWindow = runBinding?.window ?? (accountWindows?.length && widget.dateScope?.mode !== 'absolute' ? view?.window : requestedWindow)
    const reportScope = !widget.dateScope || widget.dateScope.mode === 'inherit' || !!(window && effectiveWindow?.start === window.start && effectiveWindow.end === window.end)
    const local: BoardGenerationIssue[] = []
    const issue = (code: string, detail: Pick<BoardGenerationIssue, 'expectedWindow' | 'actualWindow'> = {}) => local.push({ code, widgetId: widget.id, datasetId: dataset?.id ?? binding.datasetId, ...detail })
    if (!dataset) {
      issue(binding.datasetId.startsWith('meta-reading:') ? 'native-data-unverified' : 'dataset-missing')
      const missing = { valid: false, live: false, attribution: false, media: binding.datasetId.startsWith('meta-reading:'), reportScope, rows: [], issues: local }
      sourceChecks.push(missing)
      return missing
    }
    const recipe = recipes.find(item => item.datasetId === (original?.id ?? dataset.id)) ?? recipes.find(item => !item.datasetId && item.datasetName === dataset.name)
    const attribution = !!dataset.appsflyer || dataset.name === 'AppsFlyer 报表' || dataset.name.startsWith('AF-') || !!recipe
    const media = source?.kind === 'meta' || dataset.name === 'TikTok 报表' || dataset.id.startsWith('meta-reading:')
    let live = media
    if (source && !['updated', 'empty'].includes(source.status)) issue(source.status === 'unbound' ? 'query-binding-missing' : source.status === 'unsupported' ? 'source-not-refreshable' : 'source-failed')
    if (source?.kind === 'tiktok' && !source.proofs?.length) issue('native-data-unverified')
    if (attribution) {
      const state = dataset.appsflyer
      live = !!recipe && !!state?.specId && state.specId === recipe.id && (!recipe.datasetId || recipe.datasetId === (original?.id ?? dataset.id))
      if (!live) issue('query-binding-missing')
      const query = recipe?.query
      if (!query || !Array.isArray(query.app_ids) || query.app_ids.length !== 1 || !text(query.app_ids[0])) issue('application-scope-unverified')
      const mediaFilter = object(query?.filters) ? query.filters['Media source'] : undefined
      if (mediaFilter !== undefined && (!Array.isArray(mediaFilter) || mediaFilter.some(value => !text(value) || value.toLowerCase() === 'all'))) issue('media-scope-invalid')
      if (state?.status === 'failed') issue('source-failed')
      else if (state?.status === 'unbound') issue('query-binding-missing')
      else if (state?.status === 'empty') issue('source-empty')
      if (!state?.dataWindow || state.dataWindow.start !== state.window.start || state.dataWindow.end !== state.window.end || (effectiveWindow && (state.window.start !== effectiveWindow.start || state.window.end !== effectiveWindow.end))) issue('source-window-unverified', { ...(effectiveWindow ? { expectedWindow: { ...effectiveWindow } } : {}), ...(state ? { actualWindow: { ...(state.dataWindow ?? state.window) } } : {}) })
    }
    const metricIndex = binding.metric ? dataset.columns.findIndex(column => column.name === binding.metric && column.type === 'number') : -1
    const needsMetric = ['counter', 'chart-line', 'chart-bar', 'funnel', 'analysis'].includes(widget.type)
    let valid = needsMetric ? !!binding.metric && metricIndex >= 0 : !binding.metric || metricIndex >= 0
    if (!valid) issue('metric-missing')
    const chart = widget.type === 'chart-line' || widget.type === 'chart-bar'
    if ((chart || (widget.type === 'analysis' && widget.config.dimension)) && !dataset.columns.some(column => column.name === widget.config.dimension)) { valid = false; issue('dimension-missing') }
    let rows = dataset.rows
    if (effectiveWindow && !accountWindows?.length) {
      const scoped = filterDatasetRowsByWindowWithStatus(dataset, effectiveWindow, { latestDay: !source && !widget.dateScope && board.masterScope?.range === 'today', now })
      rows = scoped.dataset.rows
      if (scoped.missingTimezone) issue('account-scope-unverified')
    }
    if (dataset.name === 'TikTok 报表' && allTtIds.length) {
      const index = dataset.columns.findIndex(column => ['广告主id', 'advertiserid'].includes(key(column.name)))
      if (index >= 0) rows = rows.filter(row => allTtIds.includes(String(row[index])))
      else issue('account-scope-unverified')
    }
    const filterValues = binding.filterValues ?? (binding.filterValue ? [binding.filterValue] : [])
    if (binding.filterColumn && filterValues.length) {
      const index = dataset.columns.findIndex(column => column.name === binding.filterColumn)
      if (index < 0) { valid = false; issue('filter-column-missing') }
      else rows = rows.filter(row => filterValues.includes(String(row[index])))
    }
    if (attribution && binding.metric && eventMetrics.has(key(binding.metric))) {
      const selectedEvent = Array.isArray(recipe?.query?.in_app_event) && recipe.query.in_app_event.some(text)
      const filteredEvent = !!binding.filterColumn && eventKeys.has(key(binding.filterColumn)) && (text(binding.filterValue) || !!binding.filterValues?.some(text))
      if (!selectedEvent && !filteredEvent) issue('event-mapping-unverified')
    }
    if (!rows.length) issue('source-empty')
    else if (binding.metric && metricIndex >= 0 && !rows.some(row => typeof row[metricIndex] === 'number' && Number.isFinite(row[metricIndex]))) issue('metric-data-empty')
    if (binding.metric && metricIndex >= 0 && rows.length) {
      const scoped = { ...dataset, rows }
      const safety = metricCurrencySafety(scoped, binding.metric)
      if (safety === 'mixed') issue('currency-mixed')
      else if (safety === 'unknown') issue('currency-unverified')
      const op = binding.op ?? 'sum'
      const dimension = dataset.columns.findIndex(column => column.name === widget.config.dimension)
      const result = chart && dimension >= 0 ? safeMetricGroups(scoped, dimension, metricIndex, op, 'Other') : safeMetricValue(scoped, rows, metricIndex, op)
      if (result === null) issue('metric-aggregation-unavailable')
    }
    if (binding.metric && uniqueMetrics.has(key(binding.metric)) && rows.length > 1 && (!binding.op || binding.op === 'sum')) issue('non-additive-sum')
    if (attribution && object(recipe?.query?.filters) && Array.isArray(recipe.query.filters['Media source'])) {
      const values = recipe.query.filters['Media source'] as unknown[]
      const index = dataset.columns.findIndex(column => sourceKeys.has(key(column.name)))
      if (index >= 0 && values.length && rows.some(row => truth(row[index]) && !values.includes(String(row[index])))) issue('media-scope-mismatch')
    }
    const result = { valid, live, attribution, media, reportScope, dataset, rows, issues: local }
    sourceChecks.push(result)
    return result
  }

  for (const widget of board.widgets) {
    if (options.mode === 'default' && ['counter', 'chart-line', 'chart-bar', 'gauge', 'reading-module', 'reading-snapshot'].includes(widget.type) && widget.config.source !== 'dataset') {
      issues.push({ code: 'manual-business-data', widgetId: widget.id })
    }
    const bindings = boardWidgetDatasetBindings(widget)
    const checks = bindings.map(binding => inspect(widget, binding))
    // Match the actual table renderer (first eight columns by default) and grouped chart/analysis labels.
    // Counters/funnel totals and native reader account pickers do not show an ID-level breakdown.
    const display = checks.length === 1 ? checks[0] : undefined
    if (display?.valid && display.dataset && display.rows.length && !display.issues.length) {
      const columns = widget.type === 'table' ? (Array.isArray(widget.config.columns) ? widget.config.columns.filter((value): value is string => typeof value === 'string') : display.dataset.columns.slice(0, 8).map(column => column.name)) : ['chart-line', 'chart-bar', 'analysis'].includes(widget.type) && typeof widget.config.dimension === 'string' ? [widget.config.dimension, ...(bindings[0]?.metric ? [bindings[0].metric] : [])] : []
      if (columns.length && columns.every(name => display.dataset!.columns.some(column => column.name === name))) projections.push({ dataset: display.dataset, rows: display.rows, columns })
    }
    const numeric = checks.some(check => check.valid && check.live && (check.dataset?.columns.some((column, index) => column.type === 'number' && (widget.type !== 'table' || !Array.isArray(widget.config.columns) || widget.config.columns.includes(column.name)) && check.rows.some(row => typeof row[index] === 'number' && Number.isFinite(row[index])))))
    if (numeric) found.data = true
    if (checks.some(check => check.valid && check.live && check.attribution)) found['third-party'] = true
    addIssues(['data', 'third-party'], checks.flatMap(check => check.issues))
    if (widget.type === 'tt-reading' || widget.type === 'meta-reading') {
      // The native pipeline exists, but Main may not have its current rows.
      // dataAvailable and native-data-unverified keep this from claiming a read.
      const datasetId = widget.type === 'tt-reading' ? datasets.find(dataset => dataset.name === 'TikTok 报表')?.id : `meta-reading:${widget.id}`
      if (datasetId) {
        const native = inspect(widget, { source: 'dataset', datasetId })
        if (native.valid && native.live && native.dataset?.columns.some((column, index) => column.type === 'number' && native.rows.some(row => typeof row[index] === 'number' && Number.isFinite(row[index])))) found.data = true
        addIssues(['data'], native.issues)
      } else addIssues(['data'], [{ code: 'native-data-unverified', widgetId: widget.id }])
    }
    if (widget.type === 'chart-line' || widget.type === 'chart-bar') {
      const dateDimension = checks[0]?.dataset?.columns.some(column => column.name === widget.config.dimension && column.type === 'date')
      const trendCandidate = widget.type === 'chart-line' || dateDimension
      const valid = checks.length === 1 && checks[0].valid && !!bindings[0]?.metric && dateDimension
      if (valid) found.trend = true
      if (required.has('trend') && trendCandidate) {
        if (!valid) issues.push({ code: 'trend-date-binding-missing', widgetId: widget.id })
        else {
          const dataset = checks[0].dataset!
          const dateIndex = dataset.columns.findIndex(column => column.name === widget.config.dimension)
          const metricIndex = dataset.columns.findIndex(column => column.name === bindings[0].metric)
          const days = new Set(checks[0].rows.flatMap(row => {
            const date = row[dateIndex], value = row[metricIndex]
            return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date && typeof value === 'number' && Number.isFinite(value) ? [date] : []
          }))
          if (days.size < 2) issues.push({ code: 'trend-history-insufficient', widgetId: widget.id, datasetId: dataset.id })
        }
        addIssues(['trend'], checks.flatMap(check => [...check.issues, ...(!check.live ? [{ code: 'source-not-refreshable', widgetId: widget.id, datasetId: check.dataset?.id }] : [])]))
      }
    }
    if (widget.type === 'funnel') {
      const valid = bindings.length >= 2 && bindings.length <= 12 && checks.every(check => check.valid)
      if (valid) found.funnel = true
      if (required.has('funnel')) {
        if (!valid) issues.push({ code: 'funnel-stage-binding-missing', widgetId: widget.id })
        addIssues(['funnel'], checks.flatMap(check => [...check.issues, ...(!check.live ? [{ code: 'source-not-refreshable', widgetId: widget.id, datasetId: check.dataset?.id }] : [])]))
      }
    }
    if (widget.type === 'analysis') {
      const valid = checks.length === 1 && checks[0].valid && checks[0].live && !!bindings[0]?.metric
      if (valid) found.analysis = true
      if (required.has('analysis')) {
        if (!valid) issues.push({ code: 'analysis-binding-missing', widgetId: widget.id })
        addIssues(['analysis'], checks.flatMap(check => check.issues))
      }
    }
    if (widget.type === 'table') {
      const dataset = checks[0]?.dataset
      const columns = widget.config.columns
      const valid = checks.length === 1 && checks[0].valid && !!dataset && (columns === undefined || (Array.isArray(columns) && columns.length > 0 && columns.every(name => dataset.columns.some(column => column.name === name)))) && (!widget.config.sortColumn || dataset.columns.some(column => column.name === widget.config.sortColumn))
      if (valid) found.table = true
      if (required.has('table')) {
        if (!valid) issues.push({ code: 'table-column-binding-missing', widgetId: widget.id })
        addIssues(['table'], checks.flatMap(check => [...check.issues, ...(options.mode === 'default' && !check.live ? [{ code: 'source-not-refreshable', widgetId: widget.id, datasetId: check.dataset?.id }] : [])]))
      }
    }
  }

  const requestedGrains = options.granularity === undefined ? [] : typeof options.granularity === 'string' ? [options.granularity] : [...options.granularity]
  const showsGrain = (projection: DisplayProjection, grain: BoardGenerationGranularity) => projection.columns.some(name => {
    if (!granularityKeys[grain].has(key(name))) return false
    const index = projection.dataset.columns.findIndex(column => column.name === name)
    return projection.rows.some(row => validId(row[index]))
  })
  const displayedGrains = BOARD_GENERATION_GRANULARITIES.filter(grain => projections.some(projection => showsGrain(projection, grain)))
  const requestedDimensions = [...(options.dimensions ?? [])]
  const showsDimensions = (projection: DisplayProjection, names: readonly string[]) => {
    const indices = names.map(name => projection.columns.includes(name) ? projection.dataset.columns.findIndex(column => column.name === name) : -1)
    return indices.every(index => index >= 0) && projection.rows.some(row => indices.every(index => {
      const name = projection.dataset.columns[index].name
      return BOARD_GENERATION_GRANULARITIES.some(grain => granularityKeys[grain].has(key(name))) ? validId(row[index]) : hasValue(row[index])
    }))
  }
  const dimensionsMissing = requestedDimensions.filter(name => !projections.some(projection => showsDimensions(projection, [name])))
  const dimensionsTogether = projections.some(projection => showsDimensions(projection, requestedDimensions))
  const showsRequestedGrain = projections.some(projection => {
    const idIndices = projection.columns.filter(name => requestedGrains.some(grain => granularityKeys[grain].has(key(name)))).map(name => projection.dataset.columns.findIndex(column => column.name === name))
    const rows = projection.rows.filter(row => idIndices.some(index => validId(row[index])))
    return rows.length > 0 && (!requestedDimensions.length || showsDimensions({ ...projection, rows }, requestedDimensions))
  })
  if (requestedGrains.length && !showsRequestedGrain) issues.push({ code: 'granularity-unverified' })
  if (requestedDimensions.length && !dimensionsTogether) issues.push({ code: 'dimensions-unverified' })

  const campaignSet = (checks: BindingCheck[]) => new Set(checks.flatMap(check => {
    if (!check.dataset) return []
    const index = check.dataset.columns.findIndex(column => campaignKeys.has(key(column.name)))
    return index < 0 ? [] : check.rows.flatMap(row => truth(row[index]) ? [String(row[index])] : [])
  }))
  const mediaChecks = sourceChecks.filter(check => check.media && check.valid && check.reportScope)
  const attributionChecks = sourceChecks.filter(check => check.attribution && check.valid && check.reportScope)
  const requiresAlignment = options.mode === 'default' || (mediaChecks.length > 0 && attributionChecks.length > 0)
  const mediaIds = campaignSet(mediaChecks), attributionIds = campaignSet(attributionChecks)
  const matched = [...mediaIds].filter(id => attributionIds.has(id)).length
  const alignment: BoardGenerationAlignment = {
    status: !attributionChecks.length || !requiresAlignment ? 'not-applicable' : !mediaIds.size || !attributionIds.size ? 'unknown' : matched ? 'matched-keys' : 'unmatched',
    matchedCampaigns: matched, mediaCampaigns: mediaIds.size, attributionCampaigns: attributionIds.size,
    unmatchedMediaCampaigns: mediaIds.size - matched, unmatchedAttributionCampaigns: attributionIds.size - matched
  }
  if (required.has('third-party') && requiresAlignment && attributionChecks.length && alignment.status !== 'matched-keys') issues.push({ code: alignment.status === 'unmatched' ? 'campaign-scope-unmatched' : 'campaign-scope-unverified' })
  if (required.has('third-party') && requiresAlignment && alignment.status === 'matched-keys' && alignment.unmatchedAttributionCampaigns > 0) issues.push({ code: 'campaign-scope-partial' })
  const missing = BOARD_GENERATION_CAPABILITIES.filter(capability => required.has(capability) && !found[capability])
  const uniqueIssues = [...new Map(issues.map(issue => [`${issue.code}:${issue.widgetId ?? ''}:${issue.datasetId ?? ''}`, issue])).values()]
  return {
    status: missing.length ? 'incomplete' : uniqueIssues.length ? 'needs-attention' : 'ready', missing, issues: uniqueIssues.slice(0, 100), ...(window ? { window: { ...window } } : {}),
    ...(requestedGrains.length ? { granularity: { requested: requestedGrains, displayed: displayedGrains } } : {}),
    ...(requestedDimensions.length ? { dimensions: { requested: requestedDimensions, missing: dimensionsMissing, displayedTogether: dimensionsTogether } } : {}),
    capabilities: { ...found, refreshable: sourceChecks.length > 0 && sourceChecks.every(check => check.valid && check.live), dataAvailable: sourceChecks.some(check => check.valid && check.rows.length > 0), alignment }
  }
}
