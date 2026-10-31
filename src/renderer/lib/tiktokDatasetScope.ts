import type { BoardDataset, BoardWidget } from '../../shared/types'
import { tiktokAccountDate, type TikTokReadingRange, type TikTokReadingSummary } from '../../shared/tiktokReport'
import { tiktokReadingRangeWindow } from '../../shared/todayReading'
import { buildTikTokDatasetProofs, type TikTokDatasetProof } from '../../shared/tiktokDatasetProof'

/** Successful full read and its exact account/date windows. */
export interface VerifiedTikTokScope {
  widgetId: string
  advertiserIdsConfig: string
  range: string
  memberWidgetIds?: string[]
  proofs: TikTokDatasetProof[]
  windows: Array<{ advertiserId: string; startDate: string; endDate: string; timezone?: string }>
}

export function verifiedTikTokScope(widgetId: string, advertiserIdsConfig: string, range: string, summary: TikTokReadingSummary): VerifiedTikTokScope | null {
  const validDate = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  if (!validDate(summary.startDate) || !validDate(summary.endDate) || summary.startDate > summary.endDate) return null
  if (summary.range !== range || summary.datasetSync?.ok !== true || summary.failed.length || summary.truncated || !summary.advertisers.length) return null
  const proofs = summary.datasetSync.proofs
  if (!Array.isArray(proofs) || proofs.length !== summary.advertisers.length || proofs.some((proof) => !/^[0-9a-f]{64}$/.test(proof.digest))) return null
  const ids = summary.advertisers.map((account) => account.advertiserId)
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[1-9]\d{0,24}$/.test(id))) return null
  if (range === '1') {
    const windows = summary.accountWindows ?? []
    if (windows.length !== ids.length || new Set(windows.map((window) => window.advertiserId)).size !== ids.length || windows.some((window) => !ids.includes(window.advertiserId) || !window.timezone || !validDate(window.startDate) || window.startDate !== window.endDate)) return null
    if (!windows.every((window) => proofs.some((proof) => proof.advertiserId === window.advertiserId && proof.startDate === window.startDate && proof.endDate === window.endDate))) return null
    return { widgetId, advertiserIdsConfig, range, windows, proofs }
  }
  const windows = ids.map((advertiserId) => ({ advertiserId, startDate: summary.startDate, endDate: summary.endDate }))
  if (!windows.every((window) => proofs.some((proof) => proof.advertiserId === window.advertiserId && proof.startDate === window.startDate && proof.endDate === window.endDate))) return null
  return { widgetId, advertiserIdsConfig, range, windows, proofs }
}

export function scopeMatchesWidget(scope: VerifiedTikTokScope | null | undefined, widgets: BoardWidget[], now: number = Date.now()): scope is VerifiedTikTokScope {
  const reading = widgets.filter((widget) => widget.type === 'tt-reading')
  if (!scope || reading.length !== 1) return false
  if (scope.range === '1') {
    if (scope.windows.some((window) => tiktokAccountDate(now, window.timezone) !== window.endDate)) return false
  } else {
    if (!['yd', '3', '7', '28', '30'].includes(scope.range)) return false
    const expected = tiktokReadingRangeWindow(scope.range as TikTokReadingRange, new Date(now))
    if (scope.windows.some((window) => window.startDate !== expected.start || window.endDate !== expected.end)) return false
  }
  const widget = reading[0]
  return widget.id === scope.widgetId && (typeof widget.config.advertiserIds === 'string' ? widget.config.advertiserIds : '') === scope.advertiserIdsConfig && (typeof widget.config.range === 'string' ? widget.config.range : '7') === scope.range
}



/** Combine independently verified reading modules without counting an account twice. */
export function combineTikTokScopes(scopes: Record<string, VerifiedTikTokScope | null>, widgets: BoardWidget[], now: number = Date.now()): VerifiedTikTokScope | null {
  const reading = widgets.filter((widget) => widget.type === 'tt-reading')
  if (!reading.length) return null
  const selected: VerifiedTikTokScope[] = []
  for (const widget of reading) {
    const scope = scopes[widget.id]
    if (!scopeMatchesWidget(scope, [widget], now)) return null
    selected.push(scope)
  }
  const range = selected[0].range
  if (selected.some((scope) => scope.range !== range)) return null
  const windows = new Map<string, VerifiedTikTokScope['windows'][number]>()
  const proofs = new Map<string, TikTokDatasetProof>()
  for (const scope of selected) {
    for (const window of scope.windows) {
      const proof = scope.proofs.find((item) => item.advertiserId === window.advertiserId)
      if (!proof) return null
      const prior = proofs.get(window.advertiserId)
      const priorWindow = windows.get(window.advertiserId)
      if (prior && (prior.startDate !== proof.startDate || prior.endDate !== proof.endDate || prior.digest !== proof.digest || priorWindow?.timezone !== window.timezone)) return null
      windows.set(window.advertiserId, window)
      proofs.set(window.advertiserId, proof)
    }
  }
  return { ...selected[0], memberWidgetIds: reading.map((widget) => widget.id), windows: [...windows.values()], proofs: [...proofs.values()] }
}

/** A changed dataset snapshot must match every successful account projection. */
export async function tiktokScopeMatchesDataset(scope: VerifiedTikTokScope, dataset: BoardDataset): Promise<boolean> {
  try {
    const actual = await buildTikTokDatasetProofs(dataset, scope.windows)
    return actual.length === scope.proofs.length && actual.every((item) => scope.proofs.some((proof) => proof.advertiserId === item.advertiserId && proof.startDate === item.startDate && proof.endDate === item.endDate && proof.digest === item.digest))
  } catch { return false }
}

/** Earliest calendar boundary that changes this reading’s date window. */
export function nextTikTokScopeExpiry(scope: VerifiedTikTokScope, now: number): number | null {
  if (scope.range !== '1') {
    if (!['yd', '3', '7', '28', '30'].includes(scope.range)) return null
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return midnight.getTime()
  }
  let earliest = Infinity
  const timezones = new Set(scope.windows.map((window) => window.timezone))
  for (const timezone of timezones) {
    const day = tiktokAccountDate(now, timezone)
    if (!day) return now
    let low = now, high = now + 48 * 60 * 60 * 1000
    if (tiktokAccountDate(high, timezone) === day) return now
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (tiktokAccountDate(mid, timezone) === day) low = mid
      else high = mid
    }
    earliest = Math.min(earliest, high)
  }
  return Number.isFinite(earliest) ? earliest : now
}

/** null indicates missing identity columns, never a successful zero. */
export function filterTikTokDatasetByScope(dataset: BoardDataset, scope: VerifiedTikTokScope): BoardDataset | null {
  const idIndex = dataset.columns.findIndex((column) => column.name === '广告主ID')
  const dateIndex = dataset.columns.findIndex((column) => column.name === '日期')
  if (idIndex < 0 || dateIndex < 0 || !scope.windows.length) return null
  const windows = new Map(scope.windows.map((window) => [window.advertiserId, window]))
  return { ...dataset, rows: dataset.rows.filter((row) => {
    const window = windows.get(String(row[idIndex]))
    const date = String(row[dateIndex])
    return !!window && date >= window.startDate && date <= window.endDate
  }) }
}
