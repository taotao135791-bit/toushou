export interface AppsFlyerDatasetWindow {
  start: string
  end: string
}

export interface AppsFlyerDatasetRefreshRequest extends AppsFlyerDatasetWindow {
  /** Dataset bindings on the current board, by persisted id or legacy name. */
  datasetIds: string[]
}

export type AppsFlyerDatasetStatus = 'updated' | 'empty' | 'failed' | 'unbound'

/** Persisted with the dataset so reopening a board cannot relabel old data. */
export interface AppsFlyerDatasetState {
  specId?: string
  status: AppsFlyerDatasetStatus
  /** Window of the latest attempt. */
  window: AppsFlyerDatasetWindow
  /** Window of the rows currently stored; absent for an unverified import. */
  dataWindow?: AppsFlyerDatasetWindow
  attemptedAt: number
  error?: string
  /** Stable per-board scope slot; logical recipe identity remains specId. */
  materialization?: { boardId: string; bindingDatasetId: string; scopeKey: string }
}

export interface AppsFlyerDatasetRefreshOutcome {
  name: string
  datasetName: string
  datasetId?: string
  ok: boolean
  status: AppsFlyerDatasetStatus | 'superseded'
  window: AppsFlyerDatasetWindow
  error?: string
  rowCount?: number
}

export interface AppsFlyerDatasetRefreshResult {
  ok: boolean
  error?: string
  results: AppsFlyerDatasetRefreshOutcome[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)

export function isAppsFlyerDatasetWindow(value: unknown): value is AppsFlyerDatasetWindow {
  if (!isRecord(value)) return false
  const validDate = (date: unknown): date is string => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    const parsed = Date.parse(`${date}T00:00:00Z`)
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date
  }
  return validDate(value.start) && validDate(value.end) && value.start <= value.end && Date.parse(value.end) - Date.parse(value.start) < 366 * 86400000
}

export function parseAppsFlyerDatasetRefreshRequest(raw: unknown): AppsFlyerDatasetRefreshRequest | null {
  if (!isRecord(raw) || !isAppsFlyerDatasetWindow(raw) || !Array.isArray(raw.datasetIds) || raw.datasetIds.length === 0 || raw.datasetIds.length > 64) return null
  if (raw.datasetIds.some(id => !boundedText(id, 200))) return null
  return { start: raw.start, end: raw.end, datasetIds: [...new Set(raw.datasetIds as string[])] }
}

export function validateAppsFlyerDatasetState(raw: unknown): AppsFlyerDatasetState | null {
  if (!isRecord(raw) || !['updated', 'empty', 'failed', 'unbound'].includes(String(raw.status)) || !isAppsFlyerDatasetWindow(raw.window)) return null
  if (typeof raw.attemptedAt !== 'number' || !Number.isFinite(raw.attemptedAt) || raw.attemptedAt < 0) return null
  if (raw.specId !== undefined && !boundedText(raw.specId, 200)) return null
  if (raw.dataWindow !== undefined && !isAppsFlyerDatasetWindow(raw.dataWindow)) return null
  if ((raw.status === 'updated' || raw.status === 'empty') && (
    !isAppsFlyerDatasetWindow(raw.dataWindow) || raw.dataWindow.start !== raw.window.start || raw.dataWindow.end !== raw.window.end
  )) return null
  if (raw.error !== undefined && !boundedText(raw.error, 400)) return null
  if (raw.materialization !== undefined && (!isRecord(raw.materialization) || !boundedText(raw.materialization.boardId, 100) || !boundedText(raw.materialization.bindingDatasetId, 200) || !boundedText(raw.materialization.scopeKey, 500))) return null
  return {
    status: raw.status as AppsFlyerDatasetStatus,
    window: { start: raw.window.start, end: raw.window.end },
    attemptedAt: raw.attemptedAt,
    ...(typeof raw.specId === 'string' ? { specId: raw.specId } : {}),
    ...(isAppsFlyerDatasetWindow(raw.dataWindow) ? { dataWindow: { start: raw.dataWindow.start, end: raw.dataWindow.end } } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(isRecord(raw.materialization) ? { materialization: { boardId: String(raw.materialization.boardId), bindingDatasetId: String(raw.materialization.bindingDatasetId), scopeKey: String(raw.materialization.scopeKey) } } : {})
  }
}
