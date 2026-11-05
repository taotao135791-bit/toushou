import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import Papa from 'papaparse'
import type { BoardDatasetColumn } from '../../../shared/types'
import { createOrUpdateDataset } from '../../boardDatasets'
import { DATASET_LIMITS } from '../../../shared/datasets'
import { AppsFlyerMcpClient } from './AppsFlyerMcpClient'
import { proxyFetchFor } from '../tiktok/proxyFetch'

/**
 * AppsFlyer live dataset pipeline — GENERAL query edition.
 *
 * The agent records a NAMED pull spec per board metric group: a full official
 * query (app, event filter, metrics, groupings, geo, basis, filters — whatever
 * the official tool accepts, minus dates). Dates are injected at pull time
 * from the board's master window, so「总控刷新」re-pulls every recorded spec.
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
  /** Stable id; dataset bindings survive across refreshes via the dataset NAME. */
  id: string
  /** Short label — the dataset is AF-{name} (legacy keeps AppsFlyer 报表). */
  name: string
  datasetName: string
  /** Official query WITHOUT start_date/end_date — injected at pull time. */
  query: Record<string, unknown>
}

export interface PullWindow {
  start: string
  end: string
}

const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))

function specsFile(): string {
  return path.join(app.getPath('userData'), 'appsflyer-dataset-specs.json')
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
      const isCustom = entry.eventName.toLowerCase().startsWith('af_')
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

export function listQuerySpecs(file: string = specsFile()): AfQuerySpec[] {
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
      return !!spec && typeof spec.id === 'string' && typeof spec.name === 'string' && typeof spec.datasetName === 'string' && !!obj(spec.query)
    })
  }
  // Legacy array shape: convert once, persist in the new shape.
  const migrated = migrateLegacy(parsed)
  if (migrated.length > 0) saveSpecs(migrated, file)
  return migrated
}

function saveSpecs(specs: AfQuerySpec[], file: string = specsFile()): void {
  writeFileSync(file, JSON.stringify({ specs }, null, 2), 'utf8')
}

export function saveQuerySpec(spec: AfQuerySpec, file: string = specsFile()): AfQuerySpec[] {
  const existing = listQuerySpecs(file).filter((entry) => entry.id !== spec.id)
  const next = [...existing, spec].slice(-MAX_SPECS)
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

export function parseAfDataset(text: string): { columns: BoardDatasetColumn[]; rows: (string | number)[][] } {
  if (/^\s*## Data:\s*;\s*## Metadata:/m.test(text)) return { columns: [], rows: [] }
  const section = /^\s*## Data:\s*([^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*(?:;[ \t]*)?## Metadata:[ \t]*([^\r\n]*)/m.exec(text)
  if (!section) throw new Error('appsflyer-invalid-data')
  let metadata: Obj | null
  try { metadata = obj(JSON.parse(section[3])) } catch { throw new Error('appsflyer-invalid-metadata') }
  const csv = Papa.parse<Record<string, string>>(`${section[1]}\n${section[2]}`, { header: true, skipEmptyLines: true, dynamicTyping: false })
  if (csv.errors.length || csv.data.length >= DATASET_LIMITS.maxRows) throw new Error('appsflyer-incomplete-data')
  const headerNames = Object.keys(csv.data[0] ?? {})
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

export interface AppsFlyerPullResult {
  ok: boolean
  /** Per-spec outcomes, newest spec list order. */
  results: Array<{ name: string; datasetName: string; ok: boolean; error?: string; rowCount?: number }>
  error?: string
}

export interface AppsFlyerPullOptions {
  window: PullWindow
  /** Pull only these spec ids (default: every recorded spec). */
  specIds?: string[]
  file?: string
  specsFile?: string
  clientFactory?: (token: string) => QueryClient
}



/**
 * Re-pull every recorded spec over the window and write each dataset. Dates
 * come from the caller (the board's master scope); the recorded query carries
 * everything else. One failing spec never blocks the others.
 */
export async function pullAppsFlyerDatasets(options: AppsFlyerPullOptions): Promise<AppsFlyerPullResult> {
  const { window, file, specsFile: specsFilePath, clientFactory } = options
  if (!validDate(window.start) || !validDate(window.end) || window.start > window.end) return { ok: false, error: 'invalid-window', results: [] }
  const allSpecs = listQuerySpecs(specsFilePath)
  const specs = options.specIds ? allSpecs.filter((spec) => options.specIds!.includes(spec.id)) : allSpecs
  if (specs.length === 0) return { ok: false, error: 'no-specs', results: [] }
  const token = await verifiedToken()
  if (!token) return { ok: false, error: 'not-connected', results: [] }
  const client = clientFactory ? clientFactory(token) : new AppsFlyerMcpClient(token, async (url, init) => (await proxyFetchFor(url, 'appsflyer-api'))(url, init))
  // The tools/call gate requires the handshake: without it every query
  // fails with appsflyer-tool-unavailable (the tools map stays empty).
  try {
    await client.initialize()
  } catch (error) {
    const detail = (error as { detail?: string; statusCode?: number }).detail
    const status = (error as { statusCode?: number }).statusCode
    const reason = [status ? `http ${status}` : null, detail].filter(Boolean).join(' ')
    return { ok: false, error: 'not-connected', results: [], ...(reason ? { failed: [`initialize: ${reason}`.slice(0, 200)] } : {}) }
  }

  const results: AppsFlyerPullResult['results'] = []
  for (const spec of specs) {
    const query = { ...spec.query, start_date: window.start, end_date: window.end }
    try {
      const text = await client.queryRaw({ query })
      const parsed = parseAfDataset(text)
      // An empty answer keeps the existing dataset untouched (empty ≠ zero).
      if (parsed.rows.length === 0) {
        results.push({ name: spec.name, datasetName: spec.datasetName, ok: true, rowCount: 0 })
        continue
      }
      const built = {
        columns: parsed.columns,
        rows: parsed.rows.slice(0, DATASET_LIMITS.maxRows),
        truncated: parsed.rows.length > DATASET_LIMITS.maxRows
      }
      const written = createOrUpdateDataset(spec.datasetName, built, file)
      if (!written.ok) {
        results.push({ name: spec.name, datasetName: spec.datasetName, ok: false, error: written.error })
        continue
      }
      results.push({ name: spec.name, datasetName: spec.datasetName, ok: true, rowCount: written.dataset.rows.length })
    } catch (error) {
      const detail = (error as { detail?: string; statusCode?: number }).detail
      const status = (error as { statusCode?: number }).statusCode
      const raw = (error as { raw?: string }).raw
      const reason = [status ? `http ${status}` : null, detail, raw].filter(Boolean).join(' | ')
      results.push({ name: spec.name, datasetName: spec.datasetName, ok: false, error: `${error instanceof Error ? error.message : String(error)}${reason ? ` — ${reason}` : ''}`.slice(0, 400) })
    }
  }
  return { ok: results.every((entry) => entry.ok), results }
}
