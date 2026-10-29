// 读数证据的统一投影：把四个读数来源（FB 面板直读、FB 报表 CSV、Google 报表、
// TikTok 官方接口）各自的出处字段拍平成一个形状，供看板卡片用同一个组件展示。
// 纯投影，不含渲染；纪律：只暴露各来源真实存过的字段，缺的就是 null，不编造。
import type { FbReadingHistoryEntry } from './fbReading'
import type { FbReportStoredReading } from './fbReportCsv'
import type { GoogleReportStoredReading } from './googleReport'
import type { TikTokReadingSummary } from './tiktokReport'

/** Where the reading came from; drives the source label in the UI. */
export type ReadingEvidenceKind = 'panel' | 'csv' | 'link' | 'mcp'

export interface ReadingEvidence {
  kind: ReadingEvidenceKind
  /** TikTok readings carry their credential origin; null elsewhere. */
  auth: 'oauth' | 'pasted' | null
  /** ms epoch when the reading was captured/imported/generated; null if unknown. */
  capturedAt: number | null
  /** Account id+name, CSV file name, or report host — whatever the source stored. */
  sourceDetail: string | null
  /** Main date window label, e.g. "2026-09-15 — 2026-09-21". */
  scopeLabel: string | null
  /** Extra scope facts: timezone, currency, attribution, mixed-currency note. */
  scopeDetails: string[]
  /** How many campaigns/accounts the numbers cover; null when not applicable. */
  includedCount: number | null
  includedUnit: 'campaigns' | 'accounts' | null
  /** Accounts that failed on their own and are NOT part of the totals. */
  excludedNames: string[]
  /** Non-fatal caveats the source recorded (already-satisfied gates stay out). */
  warnings: string[]
}

/** FB 面板直读：只有通过校验的读数才会进 fb-readings.json。 */
export function fbPanelReadingEvidence(entry: FbReadingHistoryEntry): ReadingEvidence {
  const captured = Date.parse(entry.capturedAt)
  const account = entry.accountName && entry.accountName !== entry.accountId
    ? `${entry.accountName} (${entry.accountId})`
    : entry.accountId
  return {
    kind: 'panel',
    auth: null,
    capturedAt: Number.isFinite(captured) ? captured : null,
    sourceDetail: account,
    scopeLabel: entry.dateRangeLabel,
    scopeDetails: [],
    includedCount: entry.campaignCount,
    includedUnit: entry.campaignCount === null ? null : 'campaigns',
    excludedNames: [],
    warnings: []
  }
}

/** FB 报表 CSV 导入：文件名 + 汇总核对警告。 */
export function fbReportReadingEvidence(stored: FbReportStoredReading): ReadingEvidence {
  const summary = stored.summary
  const scopeLabel = summary.windowStart && summary.windowEnd
    ? `${summary.windowStart} — ${summary.windowEnd}`
    : null
  const scopeDetails: string[] = []
  if (summary.currency) scopeDetails.push(summary.currency)
  if (summary.attribution) scopeDetails.push(summary.attribution)
  return {
    kind: 'csv',
    auth: null,
    capturedAt: stored.importedAt,
    sourceDetail: stored.fileName,
    scopeLabel,
    scopeDetails,
    includedCount: summary.accounts.length,
    includedUnit: 'accounts',
    excludedNames: [],
    // The renderer already narrates sum-diff warnings next to the table; the
    // evidence view lists the offending columns so the two stay consistent.
    warnings: stored.warnings.map((issue) => issue.column ?? issue.code)
  }
}

/** Google 报表：链接自动读取（带来源 URL）或手动 CSV 导入。 */
export function googleReportReadingEvidence(stored: GoogleReportStoredReading): ReadingEvidence {
  let host: string | null = null
  if (stored.sourceUrl) {
    try {
      host = new URL(stored.sourceUrl).host
    } catch {
      host = stored.sourceUrl
    }
  }
  const scopeDetails: string[] = []
  if (stored.summary.timezone) scopeDetails.push(stored.summary.timezone)
  return {
    kind: stored.sourceUrl ? 'link' : 'csv',
    auth: null,
    capturedAt: stored.importedAt,
    sourceDetail: host ?? stored.fileName,
    scopeLabel: `${stored.summary.windowStart} — ${stored.summary.windowEnd}`,
    scopeDetails,
    includedCount: stored.summary.accounts.length,
    includedUnit: 'accounts',
    excludedNames: [],
    // 'report-scope-only' is a standing scope note, not a data caveat.
    warnings: stored.warnings.filter((warning) => warning !== 'report-scope-only')
  }
}

/** TikTok 官方接口读数：成功/失败账户分开记，失败的不在合计里。 */
export function ttMcpReadingEvidence(summary: TikTokReadingSummary): ReadingEvidence {
  const scopeDetails: string[] = []
  if (summary.currency) scopeDetails.push(summary.currency)
  if (summary.mixedCurrency) scopeDetails.push('mixed-currency')
  const advertiserName = (advertiser: { advertiserId: string; name: string | null }): string =>
    advertiser.name && advertiser.name !== advertiser.advertiserId
      ? `${advertiser.name} (${advertiser.advertiserId})`
      : advertiser.advertiserId
  return {
    kind: 'mcp',
    auth: summary.source,
    capturedAt: summary.generatedAt,
    sourceDetail: null,
    scopeLabel: `${summary.startDate} — ${summary.endDate}`,
    scopeDetails,
    includedCount: summary.advertisers.length,
    includedUnit: 'accounts',
    excludedNames: summary.failed.map(advertiserName),
    warnings: summary.truncated ? ['truncated'] : []
  }
}
