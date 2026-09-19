import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  FbAdsCampaignReading,
  FbAdsObservation,
  fbAdsReadingRejection
} from '../shared/fbAdsParser'

/**
 * FB reading history — the trend foundation for scheduled tasks and boards.
 *
 * Only VERIFIED readings (all four precision gates passed in the browser-use
 * report action) may enter this store: history consumers can trust every row
 * without re-validating. Each entry is a point-in-time capture keyed by
 * account and capturedAt; re-reading the same window appends a new sample
 * rather than replacing (trends need repeated observations). Storage is a
 * single JSON document at userData/fb-readings.json with atomic tmp+rename
 * writes (same pattern as fb-snapshots / boards), pruned to the newest
 * FB_READING_LIMITS.maxEntries samples.
 */

export const FB_READING_LIMITS = {
  maxEntries: 500,
  maxRowsPerReading: 200
} as const

export interface FbReadingHistoryRow {
  name: string
  spend: number | null
  costPerResult: number | null
  cpm: number | null
  impressions: number | null
  results: number | null
  resultType: string | null
  clicks: number | null
  ctr: number | null
  cpc: number | null
  installs: number | null
}

export interface FbReadingHistoryEntry {
  id: string
  /** ISO timestamp of the capture (from the reading's second/passing read). */
  capturedAt: string
  accountId: string
  accountName: string | null
  dateRangeLabel: string | null
  campaignCount: number | null
  totalSpend: number | null
  observation?: FbAdsObservation
  rows: FbReadingHistoryRow[]
}

export type FbReadingAppendResult =
  | { ok: true; entry: FbReadingHistoryEntry }
  | { ok: false; error: string }

/**
 * Gate + shape a parser reading into a history entry. Returns null unless
 * the reading passed ALL hard gates (fbAdsReadingRejection === null) —
 * history never stores unverified numbers.
 */
export function toFbReadingEntry(
  reading: FbAdsCampaignReading,
  capturedAt: string = new Date().toISOString()
): FbReadingHistoryEntry | null {
  if (!reading || typeof reading !== 'object') return null
  if (fbAdsReadingRejection(reading) !== null) return null
  if (!reading.accountId) return null
  if (!Array.isArray(reading.rows) || reading.rows.length === 0) return null
  if (reading.rows.length > FB_READING_LIMITS.maxRowsPerReading) return null
  if (Number.isNaN(Date.parse(capturedAt))) return null
  return {
    id: randomUUID(),
    capturedAt,
    accountId: reading.accountId,
    accountName: reading.accountName ?? null,
    dateRangeLabel: reading.dateRangeLabel ?? null,
    campaignCount: reading.campaignCount ?? null,
    totalSpend: reading.totalSpend ?? null,
    ...(reading.observation ? { observation: reading.observation } : {}),
    rows: reading.rows.map((row) => ({
      name: row.name,
      spend: row.spend ?? null,
      costPerResult: row.costPerResult ?? null,
      cpm: row.cpm ?? null,
      impressions: row.impressions ?? null,
      results: row.results ?? null,
      resultType: row.resultType ?? null,
      clicks: row.clicks ?? null,
      ctr: row.ctr ?? null,
      cpc: row.cpc ?? null,
      installs: row.installs ?? null
    }))
  }
}

/** Drop invalid entries, sort oldest-first, prune to the bound. Pure. */
export function normalizeFbReadings(
  raw: unknown,
  maxEntries: number = FB_READING_LIMITS.maxEntries
): FbReadingHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const entries: FbReadingHistoryEntry[] = []
  for (const item of raw) {
    const entry = validateFbReadingEntry(item)
    if (!entry) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  entries.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
  return entries.slice(Math.max(0, entries.length - maxEntries))
}

function validateFbReadingEntry(value: unknown): FbReadingHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id || v.id.length > 100) return null
  if (typeof v.capturedAt !== 'string' || Number.isNaN(Date.parse(v.capturedAt))) return null
  if (typeof v.accountId !== 'string' || !/^\d{6,}$/.test(v.accountId)) return null
  if (v.accountName !== null && typeof v.accountName !== 'string') return null
  if (typeof v.dateRangeLabel !== 'string' || !v.dateRangeLabel) return null
  if (typeof v.campaignCount !== 'number' || !Number.isInteger(v.campaignCount) || v.campaignCount < 0) return null
  // A clipped summary block (banner pushing totals out of the snapshot)
  // leaves totalSpend null; rows=count and consistency still verify the
  // read, so the entry must persist instead of being silently dropped.
  if (v.totalSpend !== null && (typeof v.totalSpend !== 'number' || !Number.isFinite(v.totalSpend) || v.totalSpend < 0)) return null
  if (v.observation !== undefined && !validateObservation(v.observation)) return null
  if (!Array.isArray(v.rows) || v.rows.length === 0 || v.rows.length > FB_READING_LIMITS.maxRowsPerReading) {
    return null
  }
  for (const row of v.rows) {
    if (!row || typeof row !== 'object') return null
    const r = row as Record<string, unknown>
    if (typeof r.name !== 'string' || !r.name) return null
    for (const key of ['spend', 'costPerResult', 'cpm', 'results', 'clicks', 'ctr', 'cpc', 'installs']) {
      if (r[key] !== null && typeof r[key] !== 'number') return null
    }
    if (r.impressions !== undefined && r.impressions !== null && typeof r.impressions !== 'number') return null
    if (r.resultType !== null && typeof r.resultType !== 'string') return null
  }
  // Older captures predate the impressions column. Normalize them to null so
  // history consumers see one shape while files remain backward-compatible.
  return {
    ...value,
    rows: (value as FbReadingHistoryEntry).rows.map((row) => ({ ...row, impressions: row.impressions ?? null }))
  } as FbReadingHistoryEntry
}

function validateObservation(value: unknown): value is FbAdsObservation {
  if (!value || typeof value !== 'object') return false
  const observation = value as Record<string, unknown>
  if (typeof observation.capturedAt !== 'string' || Number.isNaN(Date.parse(observation.capturedAt))) return false
  if (observation.sourceUrl !== null && typeof observation.sourceUrl !== 'string') return false
  if (observation.sourceTitle !== null && typeof observation.sourceTitle !== 'string') return false
  if (observation.currency !== null && typeof observation.currency !== 'string') return false
  if (observation.timezone !== null && typeof observation.timezone !== 'string') return false
  if (observation.attributionWindow !== null && typeof observation.attributionWindow !== 'string') return false
  if (!['complete', 'partial', 'unknown'].includes(String(observation.coverage))) return false
  if (!['wide', 'narrow', 'unknown'].includes(String(observation.columnMode))) return false
  for (const key of ['visibleRows', 'readRows']) {
    if (typeof observation[key] !== 'number' || !Number.isInteger(observation[key]) || (observation[key] as number) < 0) return false
  }
  if (observation.totalRows !== null && (typeof observation.totalRows !== 'number' || !Number.isInteger(observation.totalRows) || observation.totalRows < 0)) return false
  return true
}

function defaultReadingsFile(): string {
  return path.join(app.getPath('userData'), 'fb-readings.json')
}

function readReadings(file: string): FbReadingHistoryEntry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the FB reading history.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The FB reading history is not valid JSON.')
  }
  return normalizeFbReadings(raw)
}

function writeReadings(file: string, entries: FbReadingHistoryEntry[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

/** Newest-first listing; optional account filter for future IPC/boards. */
export function listFbReadings(
  accountId?: string,
  file: string = defaultReadingsFile()
): FbReadingHistoryEntry[] {
  const entries = readReadings(file).reverse()
  if (accountId === undefined) return entries
  return entries.filter((e) => e.accountId === accountId)
}

/**
 * Append one VERIFIED reading. Corrupt stores fail closed (no destructive
 * rewrite); callers treat the result as advisory — history never blocks the
 * report response the user is looking at.
 */
export function appendFbReading(
  reading: FbAdsCampaignReading,
  file: string = defaultReadingsFile()
): FbReadingAppendResult {
  const entry = toFbReadingEntry(reading)
  if (!entry) return { ok: false, error: 'unverified-reading' }
  let entries: FbReadingHistoryEntry[]
  try {
    entries = readReadings(file)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    writeReadings(file, normalizeFbReadings([...entries, entry]))
    return { ok: true, entry }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
