import type { TikTokTodayReading, TikTokTodayReadingInput, TikTokTodayRange, TodayWindow } from '@shared/todayReading'

/** Explicit user scope; null means no report request has been selected. */
export type TikTokPageScope = { kind: 'one'; advertiserId: string } | { kind: 'all' }

export function buildTikTokPageRead(scope: TikTokPageScope | null, range: TikTokTodayRange, requestId: string, window?: TodayWindow): TikTokTodayReadingInput | null {
  if (!scope) return null
  return { range, requestId, ...(range === 'custom' && window ? { startDate: window.start, endDate: window.end } : {}), ...(scope.kind === 'one' ? { advertiserId: scope.advertiserId } : {}) }
}

/** A single-account selection must never accept a broadened response. */
export function matchesTikTokPageRead(scope: TikTokPageScope, range: TikTokTodayRange, result: TikTokTodayReading, window?: TodayWindow): boolean {
  return result.range === range && (range !== 'custom' || !!window && result.window.start === window.start && result.window.end === window.end) && (scope.kind !== 'one' || (result.accounts.length === 1 && result.accounts[0].advertiserId === scope.advertiserId))
}

/** Keep stored rows intact while presenting only the explicitly selected scope. */
export function scopeTikTokPageData(reading: TikTokTodayReading | null, scope: TikTokPageScope | null, excluded: ReadonlySet<string> = new Set()): TikTokTodayReading | null {
  if (!reading || !scope) return null
  return { ...reading, accounts: reading.accounts.filter((account) => (scope.kind === 'all' || account.advertiserId === scope.advertiserId) && !excluded.has(account.advertiserId)) }
}
