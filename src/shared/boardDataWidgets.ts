import type { BoardWidget } from './types'
import { DATASET_LIMITS, DATASET_OPS, type DatasetOp } from './datasets'

export interface BoardDataBinding {
  source: 'dataset'
  datasetId: string
  metric?: string
  op?: DatasetOp
  filterColumn?: string
  filterValue?: string
  filterValues?: string[]
  requireVerifiedTtScope?: boolean
}

export interface FunnelStage extends BoardDataBinding { label: string; metric: string; op: DatasetOp }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\x00-\x1f\x7f]/.test(value)

function filters(raw: Record<string, unknown>, target: Record<string, unknown>): boolean {
  for (const key of ['filterColumn', 'filterValue'] as const) {
    if (raw[key] === undefined) continue
    if (!text(raw[key], DATASET_LIMITS.maxColumnNameLength, true)) return false
    if (raw[key]) target[key] = raw[key]
  }
  if (raw.filterValues !== undefined) {
    if (!Array.isArray(raw.filterValues) || raw.filterValues.length === 0 || raw.filterValues.length > 500 || raw.filterValues.some(value => !text(value, DATASET_LIMITS.maxColumnNameLength))) return false
    target.filterValues = [...new Set(raw.filterValues)]
  }
  if ((target.filterValue !== undefined || target.filterValues !== undefined) && !target.filterColumn) return false
  if (raw.requireVerifiedTtScope !== undefined && typeof raw.requireVerifiedTtScope !== 'boolean') return false
  if (raw.requireVerifiedTtScope === true) target.requireVerifiedTtScope = true
  return true
}

/** A table stores a query binding, never a second copy of the report rows. */
export function validateDataTableConfig(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.source !== 'dataset' || !text(raw.datasetId, DATASET_LIMITS.maxNameLength, true)) return null
  if (Object.keys(raw).some(key => !['source', 'datasetId', 'columns', 'pageSize', 'sortColumn', 'sortDirection', 'filterColumn', 'filterValue', 'filterValues', 'requireVerifiedTtScope'].includes(key))) return null
  const config: Record<string, unknown> = { source: 'dataset', datasetId: raw.datasetId }
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 12 || raw.columns.some(column => !text(column, DATASET_LIMITS.maxColumnNameLength)) || new Set(raw.columns).size !== raw.columns.length) return null
    config.columns = [...raw.columns]
  }
  if (raw.pageSize !== undefined && (typeof raw.pageSize !== 'number' || !Number.isSafeInteger(raw.pageSize) || raw.pageSize < 5 || raw.pageSize > 100)) return null
  config.pageSize = raw.pageSize ?? 20
  if (raw.sortColumn !== undefined) {
    if (!text(raw.sortColumn, DATASET_LIMITS.maxColumnNameLength, true)) return null
    if (raw.sortColumn) config.sortColumn = raw.sortColumn
  }
  if (raw.sortDirection !== undefined) {
    if (raw.sortDirection !== 'asc' && raw.sortDirection !== 'desc') return null
    config.sortDirection = raw.sortDirection
  }
  if (!filters(raw, config)) return null
  return config
}

/** Business order is explicit; values always come from live source bindings. */
export function validateFunnelConfig(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.source !== 'dataset' || !Array.isArray(raw.stages) || raw.stages.length > 12 || raw.stages.length === 1 || Object.keys(raw).some(key => !['source', 'stages'].includes(key))) return null
  const stages: FunnelStage[] = []
  for (const value of raw.stages) {
    if (!object(value) || Object.keys(value).some(key => !['source', 'label', 'datasetId', 'metric', 'op', 'filterColumn', 'filterValue', 'filterValues', 'requireVerifiedTtScope'].includes(key)) || (value.source !== undefined && value.source !== 'dataset')) return null
    if (!text(value.label, 100) || !text(value.datasetId, DATASET_LIMITS.maxNameLength) || !text(value.metric, DATASET_LIMITS.maxColumnNameLength)) return null
    if (value.op !== undefined && (typeof value.op !== 'string' || !(DATASET_OPS as readonly string[]).includes(value.op))) return null
    const stage: Record<string, unknown> = { label: value.label, source: 'dataset', datasetId: value.datasetId, metric: value.metric, op: value.op ?? 'sum' }
    if (!filters(value, stage)) return null
    stages.push(stage as unknown as FunnelStage)
  }
  return { source: 'dataset', stages }
}

export function validateAnalysisConfig(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.source !== 'dataset' || !text(raw.datasetId, DATASET_LIMITS.maxNameLength, true) || !text(raw.metric, DATASET_LIMITS.maxColumnNameLength, true)) return null
  if (Object.keys(raw).some(key => !['source', 'datasetId', 'metric', 'op', 'dimension', 'filterColumn', 'filterValue', 'filterValues', 'requireVerifiedTtScope'].includes(key))) return null
  if (raw.op !== undefined && (typeof raw.op !== 'string' || !(DATASET_OPS as readonly string[]).includes(raw.op))) return null
  const config: Record<string, unknown> = { source: 'dataset', datasetId: raw.datasetId, metric: raw.metric, op: raw.op ?? 'sum' }
  if (raw.dimension !== undefined) {
    if (!text(raw.dimension, DATASET_LIMITS.maxColumnNameLength, true)) return null
    if (raw.dimension) config.dimension = raw.dimension
  }
  if (!filters(raw, config)) return null
  return config
}

/** Every source referenced by a widget, including each semantic funnel stage. */
export function boardWidgetDatasetBindings(widget: BoardWidget): BoardDataBinding[] {
  if (widget.type === 'funnel') {
    const parsed = validateFunnelConfig(widget.config)
    return parsed ? parsed.stages as FunnelStage[] : []
  }
  return widget.config.source === 'dataset' && typeof widget.config.datasetId === 'string' && widget.config.datasetId
    ? [widget.config as unknown as BoardDataBinding] : []
}
