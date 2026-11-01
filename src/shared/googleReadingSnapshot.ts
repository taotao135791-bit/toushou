import type { GoogleReportStoredReading } from './googleReport'
import { validateReadingSnapshot, type ReadingSnapshot } from './readingSnapshot'

/** Preserve the Google report's own date range; the Today calendar cannot relabel it. */
export function googleReadingSnapshot(reading: GoogleReportStoredReading, capturedAt: number): ReadingSnapshot | null {
  const window = { start: reading.summary.windowStart, end: reading.summary.windowEnd }
  return validateReadingSnapshot({
    kind: 'reading-snapshot', version: 1, rangeLabel: 'Google Ads report', window, capturedAt,
    accounts: reading.summary.accounts.map(account => ({
      platform: 'google', accountId: account.accountId, name: account.accountName?.slice(0, 200) ?? null,
      status: 'ok', statusDetail: null, window, previousWindow: null, sourceAt: reading.importedAt,
      timezone: reading.summary.timezone ?? null, currency: account.currency,
      spend: account.spend, previousSpend: null, impressions: account.impressions, clicks: account.clicks,
      conversions: account.conversions, resultType: 'conversions'
    }))
  })
}
