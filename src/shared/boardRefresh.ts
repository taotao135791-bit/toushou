import type { BoardDataset, BoardWidget } from './types'
import type { BoardDateWindow } from './boardWindows'
import type { TikTokDatasetProof } from './tiktokDatasetProof'
import type { TikTokReadingSummary } from './tiktokReport'
import type { MetaReadingAccount, MetaReadingSummary } from './metaReading'

export interface BoardRefreshRequest { boardId: string }
export type BoardRefreshStatus = 'updated' | 'empty' | 'failed' | 'unbound' | 'unsupported'
export interface BoardRefreshSource {
  key: string
  kind: 'tiktok' | 'meta' | 'appsflyer' | 'dataset'
  status: BoardRefreshStatus
  window: BoardDateWindow
  /** Coverage gap, such as today's AF data or a failed TikTok account. */
  partial?: boolean
  coverage?: { available: number; requested: number }
  dataset?: BoardDataset
  proofs?: TikTokDatasetProof[]
  accountWindows?: TikTokReadingSummary['accountWindows']
  error?: string
}
export interface BoardRefreshWidget {
  widgetId: string
  window: BoardDateWindow
  status: BoardRefreshStatus
  bindings: Array<{ datasetId: string; sourceKey: string; window?: BoardDateWindow; accountWindows?: Array<{ advertiserId: string; startDate: string; endDate: string }> }>
  nativeSourceKey?: string
  ttSummary?: TikTokReadingSummary
  metaSummary?: MetaReadingSummary
  metaAccounts?: MetaReadingAccount[]
  metaAccountsPartial?: boolean
  accountWindows?: Array<{ advertiserId: string; startDate: string; endDate: string }>
}
export interface BoardRefreshDataset extends BoardDataset { resolvedWindow?: BoardDateWindow }
export function boardDatasetViewWindow(dataset: BoardDataset): BoardDateWindow | undefined { return (dataset as BoardRefreshDataset).resolvedWindow }

/** A captured source can serve several date slices without reading mutable global rows. */
export function boardRefreshWidgetDatasets(result: BoardRefreshResult, widget: BoardWidget, fallback: BoardDataset[] = []): BoardRefreshDataset[] {
  const view = result.widgets.find(item => item.widgetId === widget.id)
  if (!view) return fallback
  const projected = view.bindings.map((binding): BoardRefreshDataset | undefined => {
    const source = result.sources.find(item => item.key === binding.sourceKey)
    const original = fallback.find(item => item.id === binding.datasetId || item.name === binding.datasetId)
    const data = source?.dataset ?? original
    if (!data) return undefined
    const date = data.columns.findIndex(column => column.type === 'date'), account = data.columns.findIndex(column => column.name === '广告主ID')
    const ready = source?.status === 'updated' || source?.status === 'empty' || source?.kind === 'dataset'
    const rows = ready ? data.rows.filter(row => {
      const accountWindow = binding.accountWindows?.find(window => window.advertiserId === String(row[account]))
      const window = accountWindow ? { start: accountWindow.startDate, end: accountWindow.endDate } : binding.window ?? view.window
      return date < 0 || (String(row[date]) >= window.start && String(row[date]) <= window.end)
    }) : []
    const appsflyer = source?.kind === 'appsflyer' && data.appsflyer && (source.status === 'failed' || source.status === 'unbound') ? { ...data.appsflyer, status: source.status, window: view.window } : data.appsflyer
    return { ...data, id: original?.id ?? binding.datasetId, name: original?.name ?? data.name, rows, resolvedWindow: binding.window ?? view.window, ...(appsflyer ? { appsflyer } : {}) }
  }).filter((data): data is BoardRefreshDataset => !!data)
  const ids = new Set(projected.map(data => data.id))
  return [...new Map(projected.map(data => [data.id, data])).values(), ...fallback.filter(data => !ids.has(data.id))]
}
/** Snapshots belong to this run, so a later shared-dataset write cannot mix sources. */
export interface BoardRefreshResult {
  ok: boolean
  boardId: string
  runId: string
  planKey: string
  reportWindow: BoardDateWindow
  generatedAt: number
  status: 'ready' | 'partial' | 'failed' | 'superseded'
  sources: BoardRefreshSource[]
  widgets: BoardRefreshWidget[]
  queryVersions?: Array<{ specId: string; digest: string }>
  error?: string
}

const completed = (status: BoardRefreshStatus) => status === 'updated' || status === 'empty'

export function boardRefreshCoverageStatus(result: BoardRefreshResult): 'ready' | 'partial' | 'failed' {
  if (result.widgets.every(widget => completed(widget.status)) && !result.sources.some(source => source.kind === 'tiktok' && source.partial)) return 'ready'
  // A mixed widget can still render its independent bindings after another
  // binding fails. Count at the source level to keep that coverage visible.
  const available = result.sources.some(source => {
    if (completed(source.status)) return true
    const data = source.kind === 'dataset' ? source.dataset : undefined
    if (!data?.rows.length) return false
    const date = data.columns.findIndex(column => column.type === 'date')
    if (date < 0) return true
    const windows = result.widgets.flatMap(widget => widget.bindings.filter(binding => binding.sourceKey === source.key).map(binding => binding.window ?? widget.window))
    return data.rows.some(row => windows.some(window => String(row[date]) >= window.start && String(row[date]) <= window.end))
  })
  return available ? 'partial' : 'failed'
}

/** Remove authorized rows for a disconnected source while keeping other reads. */
export function dropBoardRefreshSource(result: BoardRefreshResult, kind: BoardRefreshSource['kind']): BoardRefreshResult | undefined {
  const keys = new Set(result.sources.filter(source => source.kind === kind).map(source => source.key))
  if (!keys.size) return result
  const sources = result.sources.map(source => keys.has(source.key)
    ? { key: source.key, kind, window: source.window, status: 'failed' as const, error: 'source-disconnected' }
    : source)
  const widgets = result.widgets.map(widget => {
    if (widget.nativeSourceKey && keys.has(widget.nativeSourceKey)) return { widgetId: widget.widgetId, window: widget.window, status: 'failed' as const, bindings: widget.bindings, nativeSourceKey: widget.nativeSourceKey }
    if (widget.bindings.some(binding => keys.has(binding.sourceKey))) return { ...widget, status: 'failed' as const }
    return widget
  })
  const next: BoardRefreshResult = { ...result, sources, widgets, ok: false, status: 'partial' }
  return boardRefreshCoverageStatus(next) === 'partial' ? next : undefined
}

export function parseBoardRefreshRequest(raw: unknown): BoardRefreshRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  return Object.keys(value).length === 1 && typeof value.boardId === 'string' && value.boardId.length > 0 && value.boardId.length <= 100 && !/[\x00-\x1f\x7f]/.test(value.boardId) ? { boardId: value.boardId } : null
}
