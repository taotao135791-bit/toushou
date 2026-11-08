import { createHash, randomUUID } from 'node:crypto'
import type { BoardDataset, BoardWidget, KanbanBoard } from '../shared/types'
import type { BoardRefreshRequest, BoardRefreshResult, BoardRefreshSource, BoardRefreshWidget } from '../shared/boardRefresh'
import { boardReportWindow, boardWidgetWindow, boardRefreshPlanKey, type BoardDateWindow } from '../shared/boardWindows'
import { boardWidgetDatasetBindings } from '../shared/boardDataWidgets'
import { buildTikTokDatasetProofPayloads } from '../shared/tiktokDatasetProof'
import { isTikTokReportWindow, parseTikTokAdvertiserIdList, tiktokAccountDate, type TikTokReadingResult, type TikTokReadingSummary } from '../shared/tiktokReport'
import { listBoards } from './boards'
import { boardBuildRoot } from './boardBuildStorage'
import { listDatasets } from './boardDatasets'
import { listQuerySpecs, pullAppsFlyerDatasets, type AfQuerySpec, type AppsFlyerPullOptions } from './integrations/appsflyer/appsflyerDataset'
import { buildTikTokReadingSummary, summarizeTikTokReportRows } from './integrations/tiktok/tiktokReading'
import type { TikTokReportRow } from './integrations/tiktok/tiktokClient'
import { isMetaAccountId, isMetaReadingRange, type MetaReadingAccount, type MetaReadingResult, type MetaReadingSummary } from '../shared/metaReading'
import { metaReadingDataset } from '../shared/metaReadingDataset'

type MetaBoardInput = { action: 'accounts' } | { action: 'summary'; accountId: string; range: MetaReadingSummary['range']; window: BoardDateWindow }
type MetaBoardResult = MetaReadingResult<MetaReadingSummary | { accounts: MetaReadingAccount[]; partial: boolean }>
async function defaultMetaRead(input: MetaBoardInput): Promise<MetaBoardResult> { return (await import('./metaConnection')).readMetaBoard(input) }
export async function readBoardMetaAccounts(): Promise<MetaReadingResult<{ accounts: MetaReadingAccount[]; partial: boolean }>> {
  const result = await defaultMetaRead({ action: 'accounts' })
  return result.ok && 'accounts' in result.data ? { ok: true, data: result.data } : result.ok ? { ok: false, error: 'meta-accounts-unavailable' } : result
}

export interface BoardRefreshDeps {
  now?: () => number
  contextKey?: string
  stillAuthorized?: () => boolean
  readBoards?: () => KanbanBoard[]
  readDatasets?: () => BoardDataset[]
  readSpecs?: () => AfQuerySpec[]
  readTt?: (input: { advertiserIds: string; window: BoardDateWindow; accountLookbackDays?: number }, canCommit: () => boolean) => Promise<TikTokReadingResult>
  pullAf?: (options: AppsFlyerPullOptions) => ReturnType<typeof pullAppsFlyerDatasets>
  readMeta?: (input: MetaBoardInput) => Promise<MetaBoardResult>
}
const generations = new Map<string, number>()
const latest = new Map<string, BoardRefreshResult>()
/** Source disconnects invalidate trusted ready runs in every local draft/profile context. */
export function invalidateBoardRefreshSource(kind: BoardRefreshSource['kind']): void {
  for (const [key, result] of latest) if (result.sources.some(source => source.kind === kind)) {
    latest.delete(key)
    generations.set(key, (generations.get(key) ?? 0) + 1)
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const recipeDigest = (spec: AfQuerySpec) => digest(JSON.stringify(spec.query))
function queryVersionsMatch(versions: NonNullable<BoardRefreshResult['queryVersions']>, readSpecs: () => AfQuerySpec[]): boolean {
  if (!versions.length) return true
  try { const specs = readSpecs(); return versions.every(version => specs.some(spec => spec.id === version.specId && recipeDigest(spec) === version.digest)) } catch { return false }
}
const isAf = (data: BoardDataset | undefined, id: string) => !!data?.appsflyer || data?.name === 'AppsFlyer 报表' || (data?.name ?? id).startsWith('AF-')
const isTt = (data: BoardDataset | undefined, id: string) => data?.name === 'TikTok 报表' || id === 'TikTok 报表'
const sameWindow = (a: BoardDateWindow, b: BoardDateWindow) => a.start === b.start && a.end === b.end
const success = (status: string) => status === 'updated' || status === 'empty'
const scopedRows = (data: BoardDataset, window: BoardDateWindow, ids?: string[]): BoardDataset => {
  const date = data.columns.findIndex(column => column.type === 'date'), account = data.columns.findIndex(column => column.name === '广告主ID')
  return { ...structuredClone(data), rows: data.rows.filter(row => (date < 0 || (String(row[date]) >= window.start && String(row[date]) <= window.end)) && (!ids || !ids.length || (account >= 0 && ids.includes(String(row[account]))))).map(row => [...row]) }
}
/** One result is published only for the exact saved query configuration that requested it. */
export function getLatestBoardRefresh(board: KanbanBoard, contextKey = boardBuildRoot() ?? '', now = Date.now(), readSpecs = () => listQuerySpecs(undefined, { persistMigration: false })): BoardRefreshResult | undefined {
  const result = latest.get(`${contextKey}:${board.id}`)
  return result?.planKey === boardRefreshPlanKey(board) && sameWindow(result.reportWindow, boardReportWindow(board, now)) && queryVersionsMatch(result.queryVersions ?? [], readSpecs) && result.sources.every(source => !source.accountWindows?.some(window => tiktokAccountDate(now, window.timezone) !== window.endDate)) ? result : undefined
}
/** Trusted draft publication can promote the already verified run, never model input. */
export function adoptBoardRefreshSnapshot(board: KanbanBoard, result: BoardRefreshResult, contextKey = '', now = Date.now(), readSpecs = () => listQuerySpecs(undefined, { persistMigration: false })): boolean {
  if (result.boardId !== board.id || result.planKey !== boardRefreshPlanKey(board) || result.status === 'superseded' || !sameWindow(result.reportWindow, boardReportWindow(board, now)) || !queryVersionsMatch(result.queryVersions ?? [], readSpecs) || result.sources.some(source => source.accountWindows?.some(window => tiktokAccountDate(now, window.timezone) !== window.endDate))) return false
  latest.set(`${contextKey}:${board.id}`, structuredClone(result))
  return true
}

function advertiserScope(widget: BoardWidget, board: KanbanBoard): string | null {
  if (widget.type === 'tt-reading') return parseTikTokAdvertiserIdList(widget.config.advertiserIds ?? '')?.sort().join(',') ?? null
  if (widget.config.filterColumn === '广告主ID') {
    const values = Array.isArray(widget.config.filterValues) ? widget.config.filterValues : [widget.config.filterValue]
    return parseTikTokAdvertiserIdList(values.filter(value => typeof value === 'string').join(','))?.sort().join(',') ?? null
  }
  const readings = board.widgets.filter(item => item.type === 'tt-reading')
  const scopes = readings.map(item => parseTikTokAdvertiserIdList(item.config.advertiserIds ?? ''))
  if (scopes.some(value => value === null)) return null
  if (scopes.some(value => value!.length === 0)) return ''
  return [...new Set(scopes.flatMap(value => value!))].sort().join(',')
}
function croppedSummary(summary: TikTokReadingSummary, dataset: BoardDataset, window: BoardDateWindow): TikTokReadingSummary {
  const col = (name: string) => dataset.columns.findIndex(column => column.name === name)
  const str = (row: (string | number)[], name: string) => String(row[col(name)] ?? '')
  const num = (row: (string | number)[], name: string) => typeof row[col(name)] === 'number' ? row[col(name)] as number : null
  const rows = scopedRows(dataset, window).rows.map(row => ({ date: str(row, '日期'), advertiserId: str(row, '广告主ID'), campaignId: str(row, '活动ID'), campaignName: str(row, '活动名称'), spend: num(row, '消耗'), impressions: num(row, '展示'), clicks: num(row, '点击'), conversion: num(row, '转化'), ctr: num(row, '点击率'), cpc: num(row, '平均点击成本'), costPerConversion: num(row, '转化成本') })) as TikTokReportRow[]
  const aggregate = summarizeTikTokReportRows(rows)
  return { ...summary, startDate: window.start, endDate: window.end, totals: summary.currency ? aggregate.totals : { ...aggregate.totals, spend: null, costPerConversion: null }, topCampaigns: summary.currency ? aggregate.topCampaigns : [] }
}

export async function refreshBoard(request: BoardRefreshRequest, deps: BoardRefreshDeps = {}): Promise<BoardRefreshResult> {
  const readBoards = deps.readBoards ?? listBoards, readDatasets = deps.readDatasets ?? listDatasets, readSpecs = deps.readSpecs ?? listQuerySpecs
  const now = deps.now?.() ?? Date.now(), board = readBoards().find(item => item.id === request.boardId)
  const key = `${deps.contextKey ?? boardBuildRoot() ?? ''}:${request.boardId}`, generation = (generations.get(key) ?? 0) + 1
  generations.set(key, generation)
  const result: BoardRefreshResult = { ok: false, boardId: request.boardId, runId: randomUUID(), planKey: board ? boardRefreshPlanKey(board) : '', reportWindow: boardReportWindow(board ?? {}, now), generatedAt: now, status: 'failed', sources: [], widgets: [] }
  if (!board) return { ...result, error: 'board-not-found' }
  const current = () => generations.get(key) === generation && deps.stillAuthorized?.() !== false && queryVersionsMatch(result.queryVersions ?? [], readSpecs) && readBoards().some(item => item.id === board.id && boardRefreshPlanKey(item) === result.planKey)
  if (!current()) return { ...result, error: 'permission-denied' }
  const datasets = readDatasets(), specs = readSpecs()
  type Task = { widget: BoardWidget; view: BoardRefreshWidget; datasetId: string; dataset?: BoardDataset; window: BoardDateWindow; accounts?: string | null; reader?: BoardWidget }
  const ttTasks: Task[] = [], afTasks: Task[] = [], metaTasks: Task[] = []
  const metaWindow = (reader: BoardWidget, widget: BoardWidget) => {
    if (!widget.dateScope && (!board.masterScope || reader.config.independent === true || (reader.dateScope && reader.dateScope.mode !== 'inherit'))) {
      const range = isMetaReadingRange(reader.config.range) ? reader.config.range : 'last7'
      return boardWidgetWindow(board.masterScope ? board : { masterScope: { range, metrics: [] } }, reader, now)
    }
    return boardWidgetWindow(board, widget, now)
  }
  for (const widget of board.widgets) {
    const bindings = boardWidgetDatasetBindings(widget), window = boardWidgetWindow(board, widget, now)
    if (!bindings.length && widget.type !== 'tt-reading' && !['meta-reading', 'fb-reading', 'fb-reading-summary', 'fb-report-reading', 'google-report-reading'].includes(widget.type)) continue
    const view: BoardRefreshWidget = { widgetId: widget.id, window, status: 'updated', bindings: [] }
    result.widgets.push(view)
    if (widget.type === 'tt-reading') {
      ttTasks.push({ widget, view, datasetId: 'TikTok 报表', dataset: datasets.find(item => item.name === 'TikTok 报表'), window, accounts: advertiserScope(widget, board) })
    }
    if (widget.type === 'meta-reading') { view.window = metaWindow(widget, widget); metaTasks.push({ widget, view, reader: widget, datasetId: `meta-reading:${widget.id}`, window: view.window }) }
    for (const binding of bindings) {
      const dataset = datasets.find(item => item.id === binding.datasetId) ?? datasets.find(item => item.name === binding.datasetId)
      const task = { widget, view, datasetId: binding.datasetId, dataset, window }
      if (binding.datasetId.startsWith('meta-reading:')) {
        const reader = board.widgets.find(item => item.type === 'meta-reading' && item.id === binding.datasetId.slice('meta-reading:'.length))
        metaTasks.push({ ...task, reader, ...(reader ? { window: metaWindow(reader, widget) } : {}) })
      }
      else if (isTt(dataset, binding.datasetId)) ttTasks.push({ ...task, accounts: advertiserScope(widget, board) })
      else if (isAf(dataset, binding.datasetId)) afTasks.push(task)
      else {
        const sourceKey = `saved:${binding.datasetId}`
        if (!result.sources.some(source => source.key === sourceKey)) result.sources.push({ key: sourceKey, kind: 'dataset', status: 'unsupported', window, ...(dataset ? { dataset: structuredClone(dataset) } : {}), error: dataset ? 'no-refresh-recipe' : 'dataset-missing' })
        view.bindings.push({ datasetId: binding.datasetId, sourceKey })
      }
    }
    if (!bindings.length && widget.type !== 'tt-reading' && widget.type !== 'meta-reading') view.status = 'unsupported'
  }
  const relevantRecipes = afTasks.flatMap(task => { const bindingId = task.dataset?.id ?? task.datasetId; const recipe = specs.find(spec => spec.datasetId === bindingId) ?? specs.find(spec => spec.id === task.dataset?.appsflyer?.specId) ?? specs.find(spec => !spec.datasetId && spec.datasetName === task.dataset?.name); return recipe ? [recipe] : [] })
  result.queryVersions = [...new Map(relevantRecipes.map(spec => [spec.id, { specId: spec.id, digest: recipeDigest(spec) }])).values()]
  const metaGroups = new Map<string, Task[]>()
  for (const task of metaTasks) {
    const accountId = task.reader?.config.accountId
    const key = JSON.stringify([isMetaAccountId(accountId) ? accountId : 'selection', task.window])
    const group = metaGroups.get(key) ?? []; group.push(task); metaGroups.set(key, group)
  }
  const readMeta = deps.readMeta ?? defaultMetaRead
  for (const [groupKey, tasks] of metaGroups) {
    const first = tasks[0], accountId = first.reader?.config.accountId
    const sourceKey = `meta:${digest(groupKey)}`, source: BoardRefreshSource = { key: sourceKey, kind: 'meta', status: 'unbound', window: first.window }
    result.sources.push(source)
    for (const task of tasks) { if (task.widget.type === 'meta-reading') task.view.nativeSourceKey = sourceKey; else task.view.bindings.push({ datasetId: task.datasetId, sourceKey, window: task.window }) }
    if (tasks.some(task => !task.reader)) { source.error = 'meta-source-reader-missing'; continue }
    if (!isMetaAccountId(accountId)) {
      source.error = 'source-selection-required'
      try {
        const listed = await readMeta({ action: 'accounts' })
        if (!current()) return { ...result, status: 'superseded', error: 'superseded' }
        if (listed.ok && 'accounts' in listed.data) for (const task of tasks) { task.view.metaAccounts = listed.data.accounts; task.view.metaAccountsPartial = listed.data.partial }
        else if (!listed.ok) source.error = listed.error
      } catch { source.error = 'meta-accounts-unavailable' }
      continue
    }
    if (!isTikTokReportWindow(first.window)) { source.status = 'unsupported'; source.error = 'unsupported-query-window'; continue }
    const range = isMetaReadingRange(first.reader!.config.range) ? first.reader!.config.range : board.masterScope?.range ?? 'last7'
    try {
      const read = await readMeta({ action: 'summary', accountId, range, window: first.window })
      if (!current()) return { ...result, status: 'superseded', error: 'superseded' }
      if (!read.ok) { source.status = 'failed'; source.error = read.error; continue }
      if ('accounts' in read.data || read.data.account.id !== accountId || read.data.start !== first.window.start || read.data.end !== first.window.end || read.data.rows.some(row => row.date < first.window.start || row.date > first.window.end)) { source.status = 'failed'; source.error = 'meta-source-scope-mismatch'; continue }
      source.dataset = metaReadingDataset(first.reader!.id, read.data)
      source.status = read.data.rows.length ? 'updated' : 'empty'
      for (const task of tasks) if (task.widget.type === 'meta-reading') task.view.metaSummary = structuredClone(read.data)
    } catch { source.status = 'failed'; source.error = 'meta-read-failed' }
  }
  // Same account set and report shape can share one bounded coverage read.
  const groups = new Map<string, Task[]>()
  for (const task of ttTasks) {
    const calendar = board.masterScope?.range === 'today' && task.widget.dateScope?.mode !== 'absolute' && !(task.widget.config.independent === true && !task.widget.dateScope) ? 'account-today' : 'calendar'
    const group = JSON.stringify([task.accounts ?? '__invalid__', calendar]), existing = groups.get(group) ?? []
    existing.push(task); groups.set(group, existing)
  }
  const readTt = deps.readTt ?? ((input, canCommit) => buildTikTokReadingSummary(input.accountLookbackDays ? { advertiserIds: input.advertiserIds, range: '1', accountLookbackDays: input.accountLookbackDays } : { ...input, range: '7' }, { canCommit }))
  for (const tasks of groups.values()) {
    const accounts = tasks[0].accounts ?? '__invalid__'
    const coverage = { start: tasks.map(task => task.window.start).sort()[0], end: tasks.map(task => task.window.end).sort().at(-1)! }
    const batches = isTikTokReportWindow(coverage) ? [tasks] : [...new Map(tasks.map(task => [`${task.window.start}:${task.window.end}`, tasks.filter(other => sameWindow(task.window, other.window))])).values()]
    for (const batch of batches) {
      const window = { start: batch.map(task => task.window.start).sort()[0], end: batch.map(task => task.window.end).sort().at(-1)! }
      const accountLookbackDays = board.masterScope?.range === 'today' && batch.every(task => task.widget.dateScope?.mode !== 'absolute' && !(task.widget.config.independent === true && !task.widget.dateScope)) ? Math.max(...batch.map(task => task.widget.dateScope?.mode === 'lookback' ? task.widget.dateScope.days : 1)) : undefined
      const sourceKey = `tt:${digest(`${accounts}:${accountLookbackDays ?? 'calendar'}:${window.start}:${window.end}`)}`, source: BoardRefreshSource = { key: sourceKey, kind: 'tiktok', window, status: 'failed' }
      result.sources.push(source)
      for (const task of batch) { if (task.widget.type === 'tt-reading') task.view.nativeSourceKey = sourceKey; else task.view.bindings.push({ datasetId: task.datasetId, sourceKey, window: task.window }) }
      if (accounts === '__invalid__' || !isTikTokReportWindow(window)) { source.error = 'unsupported-query-window'; continue }
      try {
        const summary = await readTt({ advertiserIds: accounts, window, ...(accountLookbackDays ? { accountLookbackDays } : {}) }, current)
        if (!current()) return { ...result, status: 'superseded', error: 'superseded' }
        if ('ok' in summary || summary.failed.length || summary.truncated || summary.datasetSync?.ok !== true || !summary.datasetSync.proofs?.length) throw new Error('tiktok-read-unverified')
        const data = readDatasets().find(item => item.name === 'TikTok 报表')
        if (!data) throw new Error('dataset-missing')
        const proofs = summary.datasetSync.proofs
        const accountIds = summary.advertisers.map(item => item.advertiserId).sort()
        if (JSON.stringify(accountIds) !== JSON.stringify(proofs.map(proof => proof.advertiserId).sort()) || (accounts && JSON.stringify(accountIds) !== JSON.stringify(accounts.split(',').sort()))) throw new Error('tiktok-account-scope-mismatch')
        if (accountLookbackDays && (!summary.accountWindows || summary.accountWindows.length !== proofs.length || proofs.some(proof => !summary.accountWindows!.some(account => account.advertiserId === proof.advertiserId && account.startDate === proof.startDate && account.endDate === proof.endDate && tiktokAccountDate(now, account.timezone) === proof.endDate && Date.parse(proof.endDate) - Date.parse(proof.startDate) === (accountLookbackDays - 1) * 86_400_000)))) throw new Error('tiktok-account-window-mismatch')
        const actual = buildTikTokDatasetProofPayloads(data, proofs)
        if (actual.length !== proofs.length || !actual.every(item => proofs.some(proof => proof.advertiserId === item.advertiserId && (accountLookbackDays || (proof.startDate === window.start && proof.endDate === window.end)) && proof.digest === digest(item.payload)))) throw new Error('tiktok-proof-mismatch')
        source.window = { start: proofs.map(proof => proof.startDate).sort()[0], end: proofs.map(proof => proof.endDate).sort().at(-1)! }
        source.dataset = scopedRows(data, source.window, summary.advertisers.map(item => item.advertiserId))
        source.proofs = structuredClone(proofs)
        if (accountLookbackDays && summary.accountWindows) source.accountWindows = structuredClone(summary.accountWindows)
        source.status = source.dataset.rows.length ? 'updated' : 'empty'
        for (const task of batch) {
          if (accountLookbackDays) {
            const days = task.widget.dateScope?.mode === 'lookback' ? task.widget.dateScope.days : 1
            const accountWindows = proofs.map(proof => ({ advertiserId: proof.advertiserId, startDate: new Date(Date.parse(`${proof.endDate}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10), endDate: proof.endDate }))
            const resolved = { start: accountWindows.map(item => item.startDate).sort()[0], end: accountWindows.map(item => item.endDate).sort().at(-1)! }
            if (task.widget.type === 'tt-reading') { task.view.accountWindows = accountWindows; task.view.window = resolved }
            else { const binding = task.view.bindings.find(item => item.sourceKey === sourceKey && item.datasetId === task.datasetId)!; binding.accountWindows = accountWindows; binding.window = resolved }
          }
          if (task.widget.type === 'tt-reading') {
            const windows = task.view.accountWindows
            const projected = windows ? { ...source.dataset, rows: source.dataset.rows.filter(row => { const scope = windows.find(item => item.advertiserId === String(row[source.dataset!.columns.findIndex(column => column.name === '广告主ID')])); const date = String(row[source.dataset!.columns.findIndex(column => column.type === 'date')]); return !!scope && date >= scope.startDate && date <= scope.endDate }) } : source.dataset
            task.view.ttSummary = { ...croppedSummary(summary, projected, task.view.window), ...(windows ? { accountWindows: windows.map(item => ({ ...item, timezone: summary.accountWindows?.find(window => window.advertiserId === item.advertiserId)?.timezone ?? 'UTC' })) } : {}) }
          }
        }
      } catch (error) { source.error = error instanceof Error ? error.message : 'tiktok-read-failed' }
    }
  }
  // A stable slot is keyed by scope POLICY, never by today's resolved dates.
  const afGroups = new Map<string, Task[]>()
  for (const task of afTasks) {
    const scopeKey = JSON.stringify(task.widget.dateScope ?? { mode: 'inherit' }), slot = `${task.dataset?.id ?? task.datasetId}:${scopeKey}`
    const group = afGroups.get(slot) ?? []; group.push(task); afGroups.set(slot, group)
  }
  for (const [slotKey, tasks] of afGroups) {
    const first = tasks[0], scopeKey = JSON.stringify(first.widget.dateScope ?? { mode: 'inherit' }), bindingId = first.dataset?.id ?? first.datasetId
    const sourceKey = `af:${digest(`${board.id}:${slotKey}`)}`, source: BoardRefreshSource = { key: sourceKey, kind: 'appsflyer', status: 'unbound', window: first.window }
    result.sources.push(source)
    for (const task of tasks) task.view.bindings.push({ datasetId: task.datasetId, sourceKey, window: task.window })
    const recipe = specs.find(spec => spec.datasetId === bindingId) ?? specs.find(spec => spec.id === first.dataset?.appsflyer?.specId) ?? specs.find(spec => !spec.datasetId && spec.datasetName === first.dataset?.name)
    if (!recipe) { source.error = 'missing-query'; continue }
    const materialization = { boardId: board.id, bindingDatasetId: bindingId, scopeKey }
    const previous = readDatasets().find(data => { const m = data.appsflyer?.materialization; return m?.boardId === board.id && m.bindingDatasetId === bindingId && m.scopeKey === scopeKey && data.appsflyer?.specId === recipe.id })
    try {
      const pulled = await (deps.pullAf ?? pullAppsFlyerDatasets)({ window: first.window, materializations: [{ specId: recipe.id, ...(previous ? { datasetId: previous.id } : {}), datasetName: `${(first.dataset?.name ?? 'AF').slice(0, 150)} · ${digest(`${board.id}:${slotKey}`).slice(0, 12)}`, materialization }], canCommit: current })
      if (!current()) return { ...result, status: 'superseded', error: 'superseded' }
      const entry = pulled.results.find(item => item.ok && item.datasetId)
      const data = entry && readDatasets().find(item => item.id === entry.datasetId)
      if (!data || !data.appsflyer?.dataWindow || !sameWindow(data.appsflyer.dataWindow, first.window) || !success(data.appsflyer.status)) { source.status = 'failed'; source.error = pulled.results[0]?.error ?? pulled.error ?? 'appsflyer-read-failed'; continue }
      source.dataset = structuredClone(data); source.status = data.rows.length ? 'updated' : 'empty'; source.partial = data.appsflyer.partial === true
    } catch (error) { source.status = 'failed'; source.error = error instanceof Error ? error.message : 'appsflyer-read-failed' }
  }
  if (!current()) return { ...result, status: 'superseded', error: 'superseded' }
  for (const widget of result.widgets) {
    const sources = [...widget.bindings.map(binding => binding.sourceKey), ...(widget.nativeSourceKey ? [widget.nativeSourceKey] : [])].map(sourceKey => result.sources.find(source => source.key === sourceKey)!)
    if (sources.some(source => !success(source.status))) widget.status = sources.find(source => !success(source.status))!.status
    else if (sources.length && sources.every(source => source.status === 'empty')) widget.status = 'empty'
  }
  const good = result.widgets.filter(widget => success(widget.status)).length
  result.status = good === result.widgets.length ? 'ready' : good ? 'partial' : 'failed'
  result.ok = result.status === 'ready'
  latest.set(key, structuredClone(result))
  return result
}
