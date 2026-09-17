import { describe, expect, it } from 'vitest'
import { boardReadingRangeDates, buildBoardReadingUrl, fbReadingMatchesWindow, parseFbReadingDateRange } from '../fbReading'

describe('FB reading date window', () => {
  const today = new Date(2026, 8, 17)
  it.each([
    ['today', '2026-09-17_2026-09-18'],
    ['last3', '2026-09-14_2026-09-17'],
    ['last7', '2026-09-10_2026-09-17'],
    ['last30', '2026-08-18_2026-09-17']
  ] as const)('encodes %s with an exclusive end and no preset', (range, expected) => {
    const url = new URL(buildBoardReadingUrl('三国IOS', range, today))
    expect(url.searchParams.get('date')).toBe(expected)
    expect(url.searchParams.get('insights_date')).toBe(expected)
    expect(url.searchParams.get('date')).not.toContain(',')
  })

  it('handles month/year/leap-day rollover without changing display dates', () => {
    expect(boardReadingRangeDates('last3', new Date(2024, 2, 1))).toEqual({ start: '2024-02-27', end: '2024-02-29' })
    expect(new URL(buildBoardReadingUrl('三国IOS', 'today', new Date(2026, 11, 31))).searchParams.get('date'))
      .toBe('2026-12-31_2027-01-01')
  })

  it('recognizes actual custom and preset labels, including a single day', () => {
    expect(parseFbReadingDateRange('2026年9月14日 – 2026年9月16日')).toEqual({ start: '2026-09-14', end: '2026-09-16' })
    expect(parseFbReadingDateRange('过去 7 天：2026年9月10日 – 2026年9月16日')).toEqual({ start: '2026-09-10', end: '2026-09-16' })
    expect(parseFbReadingDateRange('2026年9月17日')).toEqual({ start: '2026-09-17', end: '2026-09-17' })
    for (const label of ['自 2026 年 3 月 17 日起', '2026年2月30日', '2026年9月17日 – 2026年9月14日', '过去 3 天']) {
      expect(parseFbReadingDateRange(label)).toBeNull()
    }
  })

  it('refuses another account, an off-by-one date, and mismatched history', () => {
    const expected = boardReadingRangeDates('last3', today)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '2026年9月14日 – 2026年9月16日' }, '123456', expected)).toBe(true)
    expect(fbReadingMatchesWindow({ accountId: '999999', dateRangeLabel: '2026年9月14日 – 2026年9月16日' }, '123456', expected)).toBe(false)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '2026年9月14日 – 2026年9月15日' }, '123456', expected)).toBe(false)
    expect(fbReadingMatchesWindow({ accountId: '123456', dateRangeLabel: '过去 30 天：2026年8月18日 – 2026年9月16日' }, '123456', expected)).toBe(false)
  })
})
