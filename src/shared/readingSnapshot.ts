/** Immutable, local, bounded reading snapshot stored inside a board widget. */
export type ReadingSnapshotPlatform = 'facebook' | 'tiktok' | 'google'
export type ReadingSnapshotStatus = 'ok' | 'failed' | 'unattempted' | 'unavailable'
export interface ReadingSnapshotWindow { start: string; end: string }
export interface ReadingSnapshotAccount {
  platform: ReadingSnapshotPlatform
  accountId: string | null
  name: string | null
  status: ReadingSnapshotStatus
  statusDetail: string | null
  window: ReadingSnapshotWindow
  previousWindow: ReadingSnapshotWindow | null
  sourceAt: number | null
  timezone: string | null
  currency: string | null
  spend: number | null
  previousSpend: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  resultType?: string | null
}
export interface ReadingSnapshot {
  kind: 'reading-snapshot'
  version: 1
  rangeLabel: string
  window: ReadingSnapshotWindow
  capturedAt: number
  accounts: ReadingSnapshotAccount[]
}
export interface SaveReadingSnapshotInput { name: string; snapshot: ReadingSnapshot; includeChart: boolean; language?: 'zh' | 'en' }
export const READING_SNAPSHOT_ACCOUNT_LIMIT = 1000

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) }
function boundedText(value: unknown, limit: number): value is string | null { return value === null || (typeof value === 'string' && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) }
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function windowValue(value: unknown): value is ReadingSnapshotWindow {
  return record(value) && onlyKeys(value, ['start', 'end']) && date(value.start) && date(value.end) && value.start <= value.end
}
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 }
function amount(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0) }

/** Reject malformed and unexpected fields; do not silently drop accounts on save. */
export function validateReadingSnapshot(value: unknown): ReadingSnapshot | null {
  if (!record(value) || !onlyKeys(value, ['kind', 'version', 'rangeLabel', 'window', 'capturedAt', 'accounts'])) return null
  if (value.kind !== 'reading-snapshot' || value.version !== 1 || typeof value.rangeLabel !== 'string' || !value.rangeLabel.trim() || !boundedText(value.rangeLabel, 100) || !windowValue(value.window) || !timestamp(value.capturedAt) || !Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > READING_SNAPSHOT_ACCOUNT_LIMIT) return null
  for (const item of value.accounts) {
    if (!record(item) || !onlyKeys(item, ['platform', 'accountId', 'name', 'status', 'statusDetail', 'window', 'previousWindow', 'sourceAt', 'timezone', 'currency', 'spend', 'previousSpend', 'impressions', 'clicks', 'conversions', 'resultType'])) return null
    if (typeof item.platform !== 'string' || !['facebook', 'tiktok', 'google'].includes(item.platform) || typeof item.status !== 'string' || !['ok', 'failed', 'unattempted', 'unavailable'].includes(item.status)) return null
    if (!boundedText(item.accountId, 128) || !boundedText(item.name, 200) || (!item.accountId && !item.name) || !boundedText(item.statusDetail, 500) || !boundedText(item.timezone, 100)) return null
    if (item.resultType !== undefined && !boundedText(item.resultType, 100)) return null
    if (!windowValue(item.window) || !(item.previousWindow === null || windowValue(item.previousWindow)) || !(item.sourceAt === null || timestamp(item.sourceAt))) return null
    if (!(item.currency === null || (typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency)))) return null
    if (![item.spend, item.previousSpend, item.impressions, item.clicks, item.conversions].every(amount)) return null
    // A failed/unattempted/unavailable account is never represented as a valid zero.
    if (item.status !== 'ok' && [item.spend, item.previousSpend, item.impressions, item.clicks, item.conversions].some((n) => n !== null)) return null
  }
  return value as unknown as ReadingSnapshot
}
