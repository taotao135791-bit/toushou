import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { GOOGLE_REPORT_CONTRACT_VERSION, validGoogleReportUrl, parseGoogleReportCsv, type GoogleReportContext, type GoogleReportImportResult, type GoogleReportStoredReading } from '../shared/googleReport'

export const GOOGLE_REPORT_FILE_LIMIT_BYTES = 20 * 1024 * 1024
const MAX_READINGS = 200
export function defaultGoogleReportReadingsFile(): string {
  return path.join(app.getPath('userData'), 'google-report-readings.json')
}
const finiteOrNull = (n: unknown): boolean => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0)
const validDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const date = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === s
}
const validCustom = (fields: unknown): boolean => {
  if (fields === undefined) return true
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false
  const entries = Object.entries(fields)
  return entries.length <= 100 && entries.every(([key, values]) => key.length > 0 && key.length <= 120 && Array.isArray(values) && values.length <= 50 && values.every(v => typeof v === 'string' && v.length <= 200))
}
function isStoredReading(raw: unknown, id: string): raw is GoogleReportStoredReading {
  if (!raw || typeof raw !== 'object') return false
  const v = raw as GoogleReportStoredReading
  if (v.widgetId !== id || typeof v.importedAt !== 'number' || !Number.isFinite(v.importedAt) || typeof v.fileName !== 'string' || v.fileName.length > 255 || v.contractVersion !== GOOGLE_REPORT_CONTRACT_VERSION || !v.summary || !Array.isArray(v.summary.accounts) || v.summary.accounts.length > 1000 || !Array.isArray(v.warnings) || v.warnings.length > 100 || !v.warnings.every(x => typeof x === 'string' && x.length <= 200) || (v.sourceUrl !== undefined && !validGoogleReportUrl(v.sourceUrl))) return false
  if (!validDate(v.summary.windowStart) || !validDate(v.summary.windowEnd) || v.summary.windowStart > v.summary.windowEnd || (v.summary.timezone !== undefined && !/^GMT[+-]\d{1,2}(?::\d{2})?$/.test(v.summary.timezone))) return false
  return v.summary.accounts.every(a => a && typeof a.accountId === 'string' && /^\d{10}$/.test(a.accountId) && (a.accountName === null || (typeof a.accountName === 'string' && a.accountName.length <= 500)) && typeof a.currency === 'string' && /^[A-Z]{3}$/.test(a.currency) && finiteOrNull(a.spend) && a.spend !== null && finiteOrNull(a.impressions) && finiteOrNull(a.clicks) && finiteOrNull(a.conversions) && finiteOrNull(a.conversionValue) && Array.isArray(a.campaigns) && a.campaigns.length <= 100000 && a.campaigns.every(c => c && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 500 && finiteOrNull(c.spend) && c.spend !== null && finiteOrNull(c.impressions) && finiteOrNull(c.clicks) && finiteOrNull(c.conversions) && validCustom(c.customFields)))
}
export function readGoogleReportReadings(file = defaultGoogleReportReadingsFile()): Record<string, GoogleReportStoredReading> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, GoogleReportStoredReading> = {}
    for (const [id, raw] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || !isStoredReading(raw, id)) continue
      result[id] = raw
      if (Object.keys(result).length >= MAX_READINGS) break
    }
    return result
  } catch { return {} }
}
export function importGoogleReportFile(widgetId: string, filePath: string, file = defaultGoogleReportReadingsFile(), sourceUrl?: string, context?: GoogleReportContext): GoogleReportImportResult {
  if (sourceUrl && !validGoogleReportUrl(sourceUrl)) return { ok: false, error: 'file-read-failed' }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(widgetId)) return { ok: false, error: 'invalid-widget' }
  try {
    const stat = statSync(filePath)
    if (stat.size > GOOGLE_REPORT_FILE_LIMIT_BYTES) return { ok: false, error: 'file-too-large' }
    if (stat.size === 0) return { ok: false, error: 'file-empty' }
    const bytes = readFileSync(filePath)
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
    const outcome = parseGoogleReportCsv(text, context)
    if (!outcome.verification.verified || !outcome.summary) return { ok: true, outcome }
    const reading: GoogleReportStoredReading = { widgetId, importedAt: Date.now(), fileName: path.basename(filePath), contractVersion: GOOGLE_REPORT_CONTRACT_VERSION, summary: outcome.summary, warnings: outcome.verification.warnings, ...(sourceUrl ? { sourceUrl } : {}) }
    const store = readGoogleReportReadings(file)
    store[widgetId] = reading
    const trimmed = Object.entries(store).sort(([, a], [, b]) => b.importedAt - a.importedAt).slice(0, MAX_READINGS)
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(Object.fromEntries(trimmed), null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
    return { ok: true, outcome, reading }
  } catch { return { ok: false, error: 'file-read-failed' } }
}
