import { isTikTokTodayFailure, type TikTokTodayReading } from '@shared/todayReading'

/** Replace exactly the requested account, preserving the rest of the page. */
export function mergeSingleTikTokReading(previous: TikTokTodayReading, incoming: TikTokTodayReading, advertiserId: string): TikTokTodayReading | null {
  if (incoming.range !== previous.range || incoming.accounts.length !== 1 || incoming.accounts[0].advertiserId !== advertiserId || isTikTokTodayFailure(incoming.accounts[0]) || previous.accounts.filter((account) => account.advertiserId === advertiserId).length !== 1) return null
  if (incoming.range === 'custom' && (previous.window.start !== incoming.window.start || previous.window.end !== incoming.window.end)) return null
  const account = incoming.accounts[0]
  return { ...previous, accounts: previous.accounts.map((existing) => existing.advertiserId === advertiserId ? { ...account, window: account.window ?? incoming.window, previousWindow: account.previousWindow ?? incoming.previousWindow } : existing) }
}
