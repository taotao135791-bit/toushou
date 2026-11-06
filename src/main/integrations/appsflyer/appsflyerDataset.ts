import { readFileSync, writeFileSync } from 'node:fs'
import Papa from 'papaparse'
import type { BoardDataset, BoardDatasetColumn } from '../../../shared/types'
import { createOrUpdateDataset, listDatasets, updateDatasetAppsFlyerState } from '../../boardDatasets'
import { isAppsFlyerDatasetWindow, type AppsFlyerDatasetRefreshResult, type AppsFlyerDatasetState } from '../../../shared/appsflyerDataset'
import { DATASET_LIMITS, isValidDatasetId } from '../../../shared/datasets'
import { AppsFlyerMcpClient, isAppsFlyerBuiltInEvent } from './AppsFlyerMcpClient'
import { proxyFetchFor } from '../tiktok/proxyFetch'
import { boardStoragePath } from '../../boardBuildStorage'

/**
 * AppsFlyer live dataset pipeline — GENERAL query edition.
 *
 * The agent records a NAMED pull spec per board metric group: a full official
 * query (app, event filter, metrics, groupings, geo, basis, filters — whatever
 * the official tool accepts, minus dates). Dates are injected at pull time
 * from the board's master window, so refresh queries only that board's bound
 * dataset recipes. Dataset identity survives renames and date changes.
 * Each spec writes its own dataset named AF-{name} (the legacy single
 * 「AppsFlyer 报表」dataset name is preserved for specs migrated from v1), and
 * the response is parsed GENERICALLY: whatever columns the server returns
 * (Date / Geo / Event name / metric columns) become the dataset schema. Cards
 * bind by column and stay live.
 */

export const AF_DATASET_PREFIX = 'AF-'
export const LEGACY_AF_DATASET_NAME = 'AppsFlyer 报表'
const MAX_SPECS = 20

export interface AfQuerySpec {
  /** Stable recipe id; initial legacy bindings are upgraded to dataset identity. */
  id: string
  /** Short label — the dataset is AF-{name} (legacy keeps AppsFlyer 报表). */
  name: string
  datasetName: string
  /** Persisted identity; a renamed dataset keeps the same live query. */
  datasetId?: string
  /** Official query WITHOUT start_date/end_date — injected at pull time. */
  query: Record<string, unknown>
}

export interface PullWindow {
  start: string
  end: string
}

function specsFile(): string {
  return boardStoragePath('appsflyer-dataset-specs.json')
}

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null

/** Legacy v1 spec shape ({appId, eventName}) migrates to a discovery query. */
function migrateLegacy(raw: unknown): AfQuerySpec[] {
  if (!Array.isArray(raw)) return []
  const out: AfQuerySpec[] = []
  for (const item of raw) {
    const entry = obj(item)
    if (!entry) continue
    if (typeof entry.appId === 'string' && typeof entry.eventName === 'string') {
      const isCustom = !isAppsFlyerBuiltInEvent(entry.eventName)
      out.push({
        id: `afq-${entry.appId}-${entry.eventName}`.slice(0, 80),
        name: entry.eventName === 'App Active' ? '总览' : entry.eventName,
        datasetName: LEGACY_AF_DATASET_NAME,
        query: {
          app_ids: [entry.appId],
          row_count: 100,
          metrics: [
            { metric_name: 'Count', attribution_source: 'appsflyer', period: 'activity' },
            { metric_name: 'Unique users', attribution_source: 'appsflyer', period: 'activity' }
          ],
          sort_by_metrics: [{ metric_name: 'Count', order: 'desc' }],
          groupings: isCustom
            ? ['Campaign ID', 'Campaign', 'Media source', 'Date']
            : ['Event name', 'Media source', 'Date', 'Campaign ID'],
          filters: { 'Media source': ['tiktokglobal_int'] },
          ...(isCustom ? { in_app_event: [entry.eventName] } : {})
        }
      })
    }
  }
  return out
}

export function listQuerySpecs(file: string = specsFile(), options: { persistMigration?: boolean } = {}): AfQuerySpec[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const record = obj(parsed)
  if (record && Array.isArray(record.specs)) {
    return record.specs.filter((item): item is AfQuerySpec => {
      const spec = obj(item)
      return !!spec && typeof spec.id === 'string' && typeof spec.name === 'string' && typeof spec.datasetName === 'string' && (spec.datasetId === undefined || isValidDatasetId(spec.datasetId)) && !!obj(spec.query)
    })
  }
  // Legacy array shape: convert once, persist in the new shape.
  const migrated = migrateLegacy(parsed)
  if (migrated.length > 0 && options.persistMigration !== false) saveSpecs(migrated, file)
  return migrated
}

function saveSpecs(specs: AfQuerySpec[], file: string = specsFile()): void {
  writeFileSync(file, JSON.stringify({ specs }, null, 2), 'utf8')
}

export function saveQuerySpec(spec: AfQuerySpec, file: string = specsFile()): AfQuerySpec[] {
  const existing = listQuerySpecs(file).filter((entry) => entry.id !== spec.id)
  if (existing.length >= MAX_SPECS) throw new Error('query-limit')
  const next = [...existing, spec]
  saveSpecs(next, file)
  return next
}

/** Verified AF access from the connection module; null when not connected. */
let tokenSource: () => Promise<string | null> = async function defaultTokenSource(): Promise<string | null> {
  try {
    // Dynamic import survives the esbuild bundle AND keeps the import chain
    // acyclic (a lazy require here compiled to a runtime file lookup that
    // always threw MODULE_NOT_FOUND).
    const { verifiedAppsFlyerAccessToken } = await import('../../appsflyerConnection')
    return verifiedAppsFlyerAccessToken()
  } catch {
    return null
  }
}

/** Test seam: replace the verified-token source (defaults to the live connection). */
export function setAppsFlyerDatasetTokenSourceForTest(source: () => string | null | Promise<string | null>): void {
  tokenSource = async () => await source()
}

async function verifiedToken(): Promise<string | null> {
  const token = await tokenSource()
  return typeof token === 'string' && token ? token : null
}

interface QueryClient {
  initialize(): Promise<void>
  queryRaw(input: unknown): Promise<string>
}

// ---------------------------------------------------------------------------
// Generic response parse: `## Data: <csv header>\n<rows>\n; ## Metadata: {json}`
// Whatever the server returns becomes the dataset schema — Geo, Event name,
// metric columns, all of it. Empty answer (`## Data: ;`) parses to zero rows.
// ---------------------------------------------------------------------------

const COLUMN_MAP: Record<string, { name: string; type: BoardDatasetColumn['type'] }> = {
  date: { name: '日期', type: 'date' },
  'event name': { name: '事件', type: 'text' },
  'campaign id': { name: '活动ID', type: 'text' },
  campaign: { name: '活动', type: 'text' },
  'media source': { name: '媒体渠道', type: 'text' },
  geo: { name: '地区', type: 'text' },
  count: { name: '事件次数', type: 'number' },
  'unique users': { name: '独立用户', type: 'number' },
  installs: { name: '安装量', type: 'number' },
  'active users': { name: '活跃用户', type: 'number' },
  revenue: { name: '收入', type: 'number' },
  'media cost': { name: '媒体成本', type: 'number' },
  'cost per install': { name: 'CPI', type: 'number' }
}

function normalizeColumnName(rawName: string): { name: string; type: BoardDatasetColumn['type'] } {
  const key = rawName.trim().toLowerCase()
    .replace(/\s+days\s+activity\s+appsflyer$/i, '')
    .replace(/\s+days\s+install\s+appsflyer$/i, '')
    .replace(/\s+appsflyer$/i, '')
  if (COLUMN_MAP[key]) return { ...COLUMN_MAP[key] }
  return { name: rawName.trim(), type: 'text' }
}

function incompleteMetadata(value: unknown, depth = 0): boolean {
  if (depth > 16) return true
  if (Array.isArray(value)) return value.some(item => incompleteMetadata(item, depth + 1))
  const record = obj(value)
  if (!record) return false
  return Object.entries(record).some(([key, child]) =>
    (/^(?:partial(?:[-_ ]data)?\??|truncated|is[-_ ]truncated)$/i.test(key) && child === true) || incompleteMetadata(child, depth + 1)
  )
}

export function parseAfDataset(text: string, rowLimit: number = DATASET_LIMITS.maxRows): { columns: BoardDatasetColumn[]; rows: (string | number)[][] } {
  const empty = /^\s*## Data:\s*;\s*## Metadata:[ \t]*([^\r\n]*)/m.exec(text)
  if (empty) {
    let metadata: unknown
    try { metadata = JSON.parse(empty[1]) } catch { throw new Error('appsflyer-invalid-metadata') }
    if (incompleteMetadata(metadata)) throw new Error('appsflyer-incomplete-data')
    return { columns: [], rows: [] }
  }
  const section = /^\s*## Data:\s*([^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*(?:;[ \t]*)?## Metadata:[ \t]*([^\r\n]*)/m.exec(text)
  if (!section) throw new Error('appsflyer-invalid-data')
  let metadata: Obj | null
  try { metadata = obj(JSON.parse(section[3])) } catch { throw new Error('appsflyer-invalid-metadata') }
  if (!metadata) throw new Error('appsflyer-invalid-metadata')
  if (incompleteMetadata(metadata)) throw new Error('appsflyer-incomplete-data')
  const csv = Papa.parse<Record<string, string>>(`${section[1]}\n${section[2]}`, { header: true, skipEmptyLines: true, dynamicTyping: false })
  if (csv.errors.length || csv.data.length >= Math.min(rowLimit, DATASET_LIMITS.maxRows)) throw new Error('appsflyer-incomplete-data')
  const headerNames = csv.meta.fields ?? Object.keys(csv.data[0] ?? {})
  const columnDefs = headerNames.map(normalizeColumnName)
  const extra: BoardDatasetColumn[] = []
  if (typeof metadata?.timezone === 'string' && metadata.timezone) extra.push({ name: '时区', type: 'text' })
  if (typeof metadata?.currency === 'string' && metadata.currency) extra.push({ name: '币种', type: 'text' })
  const columns = [...columnDefs, ...extra]
  const rows = csv.data.map((row) => {
    const values: (string | number)[] = headerNames.map((name, index) => {
      const raw = (row[name] ?? '').trim()
      if (raw === '' || raw === '-') return ''
      const type = columnDefs[index]?.type
      if (type === 'number') {
        const parsed = Number(raw)
        return Number.isFinite(parsed) ? parsed : ''
      }
      return raw
    })
    if (metadata?.timezone && typeof metadata.timezone === 'string') values.push(metadata.timezone)
    if (metadata?.currency && typeof metadata.currency === 'string') values.push(metadata.currency)
    return values
  })
  return { columns, rows }
}

export type AppsFlyerPullResult = AppsFlyerDatasetRefreshResult

export interface AppsFlyerPullOptions {
  window: PullWindow
  /** Main-owned initial pulls can select their saved recipe before a dataset exists. */
  specIds?: string[]
  /** Board refreshes must select only the datasets bound to that board. */
  datasetIds?: string[]
  file?: string
  specsFile?: string
  clientFactory?: (token: string) => QueryClient
  /** Main planner slots reuse a recipe without redirecting its original dataset. */
  materializations?: Array<{ specId: string; datasetId?: string; datasetName: string; materialization: NonNullable<AppsFlyerDatasetState['materialization']> }>
  canCommit?: () => boolean
}

function emptyQueryColumns(query: Obj): BoardDatasetColumn[] {
  const names = [
    ...(Array.isArray(query.metrics) ? query.metrics.flatMap(metric => {
      const name = obj(metric)?.metric_name
      return typeof name === 'string' ? [name] : []
    }) : []),
    ...(Array.isArray(query.groupings) ? query.groupings.filter((value): value is string => typeof value === 'string') : [])
  ]
  return [...new Map(names.map(name => {
    const column = normalizeColumnName(name)
    return [column.name, column] as const
  })).values()].slice(0, DATASET_LIMITS.maxColumns)
}

interface PullTarget {
  spec?: AfQuerySpec
  dataset?: BoardDataset
  reference: string
  revision: number
  error?: string
  materialization?: NonNullable<AppsFlyerDatasetState['materialization']>
  outputName?: string
  storeKey?: string
}

// Reserve before any await. A slower old date request must never overwrite
// the dataset after a newer request for the same source has started.
const pullRevisions = new Map<string, number>()
let nextPullRevision = 0
const targetKey = (target: Pick<PullTarget, 'dataset' | 'spec' | 'reference' | 'outputName' | 'storeKey'>): string => JSON.stringify([target.storeKey ?? '', target.dataset?.id ?? (target.outputName ? `name:${target.outputName}` : target.spec?.datasetId ?? `name:${target.spec?.datasetName ?? target.reference}`)])
const currentTarget = (target: PullTarget): boolean => pullRevisions.get(targetKey(target)) === target.revision

function selectTargets(options: AppsFlyerPullOptions, specs: AfQuerySpec[], datasets: BoardDataset[]): PullTarget[] {
  const allowed = options.specIds ? specs.filter(spec => options.specIds!.includes(spec.id)) : specs
  const targets: Array<Omit<PullTarget, 'revision'>> = []
  if (options.materializations) {
    for (const slot of options.materializations) {
      const spec = specs.find(item => item.id === slot.specId)
      const dataset = slot.datasetId ? datasets.find(item => item.id === slot.datasetId) : undefined
      const collision = !slot.datasetId && datasets.some(item => item.name === slot.datasetName)
      targets.push({ reference: slot.datasetName, spec, dataset, outputName: slot.datasetName, materialization: slot.materialization, ...(!spec ? { error: 'missing-query' } : slot.datasetId && !dataset ? { error: 'not-found' } : collision ? { error: 'dataset-name-conflict' } : {}) })
    }
  } else if (options.datasetIds) {
    for (const reference of [...new Set(options.datasetIds)]) {
      const dataset = datasets.find(item => item.id === reference) ?? datasets.find(item => item.name === reference)
      const identities = dataset ? allowed.filter(spec => spec.datasetId === dataset.id) : []
      const candidates = identities.length > 0 ? identities : dataset ? allowed.filter(spec => !spec.datasetId && spec.datasetName === dataset.name) : []
      targets.push({ reference, dataset, ...(candidates.length === 1 ? { spec: candidates[0] } : {}) })
    }
  } else {
    for (const spec of allowed) {
      const dataset = spec.datasetId
        ? datasets.find(item => item.id === spec.datasetId)
        : datasets.find(item => item.name === spec.datasetName)
      const collision = dataset && !spec.datasetId && (
        (dataset.appsflyer?.specId && dataset.appsflyer.specId !== spec.id) ||
        specs.some(other => other.id !== spec.id && (other.datasetId === dataset.id || other.datasetName === dataset.name))
      )
      // Once a recipe has an identity binding, deleting that dataset must not
      // turn its next refresh back into a replace-by-name import.
      const error = spec.datasetId && !dataset ? 'not-found' : collision ? 'dataset-name-conflict' : undefined
      targets.push({ reference: spec.datasetName, dataset, spec, ...(error ? { error } : {}) })
    }
  }
  const storeKey = options.file ?? boardStoragePath('board-datasets.json')
  const storedTargets = targets.map(target => ({ ...target, storeKey }))
  const unique = [...new Map(storedTargets.map(target => [targetKey(target), target])).values()]
  return unique.map(target => {
    const revision = ++nextPullRevision
    pullRevisions.set(targetKey(target), revision)
    return { ...target, revision }
  })
}

/** Pull the requested recipes over an exact window; one source never refreshes another board's AF data. */
export async function pullAppsFlyerDatasets(options: AppsFlyerPullOptions): Promise<AppsFlyerPullResult> {
  const { window, file, specsFile: specsFilePath, clientFactory } = options
  if (!isAppsFlyerDatasetWindow(window)) return { ok: false, error: 'invalid-window', results: [] }
  let datasets: BoardDataset[]
  try { datasets = listDatasets(file) } catch { return { ok: false, error: 'dataset-store-unreadable', results: [] } }
  const targets = selectTargets(options, listQuerySpecs(specsFilePath), datasets)
  if (targets.length === 0) return { ok: false, error: 'no-specs', results: [] }
  const results: AppsFlyerPullResult['results'] = []
  const base = (target: PullTarget) => ({
    name: target.spec?.name ?? target.dataset?.name ?? target.reference,
    datasetName: target.dataset?.name ?? target.spec?.datasetName ?? target.reference,
    ...(target.dataset?.id ?? target.spec?.datasetId ? { datasetId: target.dataset?.id ?? target.spec?.datasetId } : {}),
    window: { ...window }
  })
  const superseded = (target: PullTarget) => {
    results.push({ ...base(target), ok: false, status: 'superseded' })
  }
  const fail = (target: PullTarget, error: string, status: 'failed' | 'unbound' = 'failed') => {
    if (!currentTarget(target) || options.canCommit?.() === false) { superseded(target); return }
    let cleanError = error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400)
    if (target.dataset && error !== 'dataset-name-conflict') {
      const state: AppsFlyerDatasetState = {
        ...(target.spec ? { specId: target.spec.id } : {}), status, window: { ...window },
        ...(target.dataset.appsflyer?.dataWindow ? { dataWindow: target.dataset.appsflyer.dataWindow } : {}),
        attemptedAt: Date.now(), error: cleanError, ...(target.materialization ? { materialization: target.materialization } : {})
      }
      const recorded = updateDatasetAppsFlyerState(target.dataset.id, state, file)
      if (!recorded.ok) cleanError = `refresh-state-${recorded.error}: ${cleanError}`.slice(0, 400)
    }
    results.push({ ...base(target), ok: false, status, error: cleanError })
  }
  const bound = targets.filter(target => {
    if (target.error) { fail(target, target.error, target.error === 'not-found' ? 'unbound' : 'failed'); return false }
    if (target.spec) return true
    fail(target, 'missing-query', 'unbound')
    return false
  })
  if (bound.length === 0) return { ok: false, error: results[0]?.error ?? 'missing-query', results }
  const token = await verifiedToken()
  if (!token) {
    bound.forEach(target => fail(target, 'not-connected'))
    return { ok: false, error: 'not-connected', results }
  }
  const client = clientFactory ? clientFactory(token) : new AppsFlyerMcpClient(token, async (url, init) => (await proxyFetchFor(url, 'appsflyer-api'))(url, init))
  try {
    await client.initialize()
  } catch {
    bound.forEach(target => fail(target, 'not-connected'))
    return { ok: false, error: 'not-connected', results }
  }
  for (const target of bound) {
    const spec = target.spec!
    if (!currentTarget(target) || options.canCommit?.() === false) { superseded(target); continue }
    const query: Obj = { ...spec.query, start_date: window.start, end_date: window.end }
    try {
      const text = await client.queryRaw({ query })
      const rowCount = typeof query.row_count === 'number' && query.row_count > 0 ? query.row_count : 100
      const parsed = parseAfDataset(text, rowCount)
      if (!currentTarget(target) || options.canCommit?.() === false) { superseded(target); continue }
      const columns = parsed.columns.length > 0 ? parsed.columns : target.dataset?.columns.length ? target.dataset.columns : emptyQueryColumns(query)
      const status = parsed.rows.length > 0 ? 'updated' : 'empty'
      const written = createOrUpdateDataset(target.dataset?.name ?? target.outputName ?? spec.datasetName, {
        columns,
        rows: parsed.rows,
        truncated: false
      }, file, {
        ...(target.dataset ? { replaceId: target.dataset.id } : {}),
        appsflyer: { specId: spec.id, status, window: { ...window }, dataWindow: { ...window }, attemptedAt: Date.now(), ...(target.materialization ? { materialization: target.materialization } : {}) }
      })
      if (!written.ok) { fail(target, written.error); continue }
      // Bind to identity after the initial pull, including an empty result.
      // Renames thereafter do not detach the query or redirect it by name.
      if (!target.materialization && (spec.datasetId !== written.dataset.id || spec.datasetName !== written.dataset.name)) {
        saveQuerySpec({ ...spec, datasetId: written.dataset.id, datasetName: written.dataset.name }, specsFilePath)
      }
      results.push({ ...base(target), datasetId: written.dataset.id, datasetName: written.dataset.name, ok: true, status, rowCount: written.dataset.rows.length })
    } catch (error) {
      const detail = (error as { detail?: string; statusCode?: number }).detail
      const status = (error as { statusCode?: number }).statusCode
      const reason = [status ? `http ${status}` : null, detail].filter(Boolean).join(' | ')
      fail(target, `${error instanceof Error ? error.message : String(error)}${reason ? ` — ${reason}` : ''}`)
    }
  }
  return { ok: results.every(entry => entry.ok || entry.status === 'superseded'), results }
}
