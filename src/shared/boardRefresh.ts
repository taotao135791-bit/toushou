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
  /** Today's AF response is partial (as of now), not a complete day. */
  partial?: boolean
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
export function parseBoardRefreshRequest(raw: unknown): BoardRefreshRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  return Object.keys(value).length === 1 && typeof value.boardId === 'string' && value.boardId.length > 0 && value.boardId.length <= 100 && !/[\x00-\x1f\x7f]/.test(value.boardId) ? { boardId: value.boardId } : null
}
