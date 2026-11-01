import { parseTikTokCustomWindow, previousEqualWindow, todayWindowForAccountDate, type TikTokTodayAccount, type TikTokTodayRange, type TikTokTodayReading, type TodayWindow } from '@shared/todayReading'
import { tiktokAccountDate } from '@shared/tiktokReport'

/** Fail closed when a completed row no longer belongs to its account's selected window. */
export function isTikTokAccountCurrent(
  account: TikTokTodayAccount,
  reading: TikTokTodayReading,
  range: TikTokTodayRange,
  customWindow?: TodayWindow,
  now: number = Date.now()
): boolean {
  if ('error' in account || reading.range !== range || !account.window || !account.previousWindow) return false
  const accountDay = tiktokAccountDate(now, account.timezone)
  if (!accountDay) return false
  const expected = range === 'custom'
    ? parseTikTokCustomWindow(customWindow?.start, customWindow?.end)
    : todayWindowForAccountDate(range, accountDay)
  if (!expected || (range === 'custom' && expected.end > accountDay)) return false
  const previous = previousEqualWindow(expected)
  return !!previous && account.window.start === expected.start && account.window.end === expected.end &&
    account.previousWindow.start === previous.start && account.previousWindow.end === previous.end
}
