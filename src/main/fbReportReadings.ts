// FB 报表导入读数的本地存储：userData/fb-report-readings.json，widgetId →
// 最近一次 verified 读数（不含原始行）。原子写（tmp + rename，同 boards.ts）。
// 纪律：未通过校验的导入绝不覆盖已存读数——失败保留旧数据。
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  FB_REPORT_CONTRACT_VERSION,
  FbReportImportResult,
  FbReportStoredReading,
  parseFbReportCsv
} from '../shared/fbReportCsv'

export const FB_REPORT_FILE_LIMIT_BYTES = 20 * 1024 * 1024
export const FB_REPORT_STORE_LIMIT = 200

export function defaultFbReportReadingsFile(): string {
  return path.join(app.getPath('userData'), 'fb-report-readings.json')
}

export function isFbReportStoredReading(value: unknown): value is FbReportStoredReading {
  if (typeof value !== 'object' || value === null) return false
  const reading = value as Record<string, unknown>
  return (
    typeof reading.widgetId === 'string' &&
    typeof reading.importedAt === 'number' &&
    typeof reading.fileName === 'string' &&
    typeof reading.contractVersion === 'number' &&
    typeof reading.summary === 'object' &&
    reading.summary !== null &&
    Array.isArray((reading.summary as { accounts?: unknown }).accounts) &&
    Array.isArray(reading.warnings)
  )
}

/** Pure parse+validate for the persisted store (test-friendly). */
export function parseFbReportReadings(json: string): Record<string, FbReportStoredReading> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, FbReportStoredReading> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue
    if (!isFbReportStoredReading(value)) continue
    out[key] = value
    if (Object.keys(out).length >= FB_REPORT_STORE_LIMIT) break
  }
  return out
}

export function readFbReportReadings(file: string = defaultFbReportReadingsFile()): Record<string, FbReportStoredReading> {
  try {
    return parseFbReportReadings(readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveFbReportReading(reading: FbReportStoredReading, file: string = defaultFbReportReadingsFile()): void {
  const store = readFbReportReadings(file)
  store[reading.widgetId] = reading
  const trimmed = Object.entries(store)
    .sort(([, a], [, b]) => b.importedAt - a.importedAt)
    .slice(0, FB_REPORT_STORE_LIMIT)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(trimmed), null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function importFbReportFile(
  widgetId: string,
  filePath: string,
  file: string = defaultFbReportReadingsFile()
): FbReportImportResult {
  try {
    const stat = statSync(filePath)
    if (stat.size > FB_REPORT_FILE_LIMIT_BYTES) return { ok: false, error: 'file-too-large' }
    if (stat.size === 0) return { ok: false, error: 'file-empty' }
    const outcome = parseFbReportCsv(readFileSync(filePath, 'utf-8'))
    if (outcome.verification.verified && outcome.summary) {
      const reading: FbReportStoredReading = {
        widgetId,
        importedAt: Date.now(),
        fileName: path.basename(filePath),
        contractVersion: FB_REPORT_CONTRACT_VERSION,
        summary: outcome.summary,
        warnings: outcome.verification.warnings
      }
      saveFbReportReading(reading, file)
      return { ok: true, outcome, reading }
    }
    // Fail closed: an unverified import never overwrites the stored reading.
    return { ok: true, outcome }
  } catch {
    return { ok: false, error: 'file-read-failed' }
  }
}
