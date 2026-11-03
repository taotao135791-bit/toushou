/** AppsFlyer aggregates retain their own attribution and completeness semantics. */
export interface MmpEventAggregate {
  source: 'appsflyer'
  mediaSource: 'tiktok' | 'other' | null
  appId: string | null
  campaignId: string | null
  day: string | null
  timezone: string | null
  dateBasis: 'activity' | 'install' | null
  metricBasis: 'activity' | 'ltv' | null
  eventName: string | null
  count: number | null
  uniqueUsers: number | null
  revenue: number | null
  currency: string | null
  /** null means completeness is unknown; it does not mean complete. */
  partial: boolean | null
  updatedAt: string | null
}

export interface TikTokCampaignDay {
  advertiserId: string
  campaignId: string
  day: string
  timezone: string | null
  currency: string | null
  spend: number | null
}

export type MmpJoinReason =
  | 'missing-identity' | 'invalid-metric' | 'unsupported-source' | 'invalid-date'
  | 'incompatible-date-basis' | 'unknown-timezone' | 'timezone-mismatch'
  | 'no-report' | 'duplicate-event' | 'ambiguous-campaign'

export type MmpEventJoin =
  | { status: 'matched'; event: MmpEventAggregate; report: TikTokCampaignDay; moneyCompatibility: 'compatible' | 'mismatch' | 'unknown' }
  | { status: 'unmatched' | 'incompatible' | 'ambiguous'; event: MmpEventAggregate; reason: MmpJoinReason }

function dateIsValid(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function validIdentity(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function validCount(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function validMoney(value: number | null): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Canonicalize aliases, but never shift or redistribute daily aggregates. */
function timezoneKey(value: string | null): string | null {
  if (!value || value !== value.trim()) return null
  const offset = /^UTC([+-])(\d{2}):(\d{2})$/i.exec(value)
  if (offset) {
    const hours = Number(offset[2]), minutes = Number(offset[3])
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
    if (hours === 0 && minutes === 0) return 'UTC'
    return `UTC${offset[1]}${offset[2]}:${offset[3]}`
  }
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone }
  catch { return null }
}

function currencyKey(value: string | null): string | null {
  return value && /^[A-Z]{3}$/.test(value) ? value : null
}

/**
 * Align one event aggregate with one campaign/day report. This is a calendar
 * association, not proof that attribution or event definitions are equal.
 * No values are summed, converted, inferred from names, or filled with zero.
 */
export function joinMmpEventsToTikTokCampaignDays(events: MmpEventAggregate[], reports: TikTokCampaignDay[]): MmpEventJoin[] {
  const duplicates = new Map<string, number>()
  for (const event of events) {
    // Other providers and install-day/LTV aggregates are independent scopes.
    if (event.source !== 'appsflyer' || event.mediaSource !== 'tiktok' || event.dateBasis !== 'activity' || event.metricBasis !== 'activity') continue
    if (!validIdentity(event.appId) || !validIdentity(event.campaignId) || !validIdentity(event.eventName) || !dateIsValid(event.day)) continue
    const key = JSON.stringify([event.appId, event.campaignId, event.eventName, event.day])
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1)
  }
  return events.map((event): MmpEventJoin => {
    const failed = (status: 'unmatched' | 'incompatible' | 'ambiguous', reason: MmpJoinReason): MmpEventJoin => ({ status, event, reason })
    if (event.source !== 'appsflyer' || event.mediaSource !== 'tiktok') return failed('incompatible', 'unsupported-source')
    if (!validIdentity(event.appId) || !validIdentity(event.campaignId) || !validIdentity(event.eventName)) return failed('incompatible', 'missing-identity')
    if (!dateIsValid(event.day)) return failed('incompatible', 'invalid-date')
    if (!validCount(event.count) || !validCount(event.uniqueUsers) || !validMoney(event.revenue)) return failed('incompatible', 'invalid-metric')
    if (event.dateBasis !== 'activity' || event.metricBasis !== 'activity') return failed('incompatible', 'incompatible-date-basis')
    if ((duplicates.get(JSON.stringify([event.appId, event.campaignId, event.eventName, event.day])) ?? 0) > 1) return failed('ambiguous', 'duplicate-event')
    const zone = timezoneKey(event.timezone)
    if (!zone) return failed('incompatible', 'unknown-timezone')
    const candidates = reports.filter(report => report.campaignId === event.campaignId && report.day === event.day)
    if (candidates.length === 0) return failed('unmatched', 'no-report')
    if (candidates.length > 1) return failed('ambiguous', 'ambiguous-campaign')
    const report = candidates[0]
    if (!validIdentity(report.advertiserId) || !validIdentity(report.campaignId)) return failed('incompatible', 'missing-identity')
    if (!validMoney(report.spend)) return failed('incompatible', 'invalid-metric')
    const reportZone = timezoneKey(report.timezone)
    if (!reportZone) return failed('incompatible', 'unknown-timezone')
    if (reportZone !== zone) return failed('incompatible', 'timezone-mismatch')
    const eventCurrency = currencyKey(event.currency), reportCurrency = currencyKey(report.currency)
    const moneyCompatibility = !eventCurrency || !reportCurrency ? 'unknown' : eventCurrency === reportCurrency ? 'compatible' : 'mismatch'
    return { status: 'matched', event, report, moneyCompatibility }
  })
}
