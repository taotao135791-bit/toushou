import { describe, expect, it } from 'vitest'
import { boardReadingRangeDates } from '../fbReading'
import { tiktokAccountDate } from '../tiktokReport'
import {
  buildTodayChatPrompt,
  fbPresetForTodayRange,
  formatReadingWindow,
  formatSpendDelta,
  parseTikTokCustomWindow,
  previousEqualWindow,
  tiktokReadingRangeWindow,
  todayWindow,
  todayWindowForAccountDate,
  todayWindowMatchesFbPreset,
  topSpendMoves
} from '../todayReading'

const today = new Date(2026, 9, 1) // local 2026-10-01

describe('account calendar dates', () => {
  it('honors IANA daylight saving and validated UTC offsets independently of the host timezone', () => {
    const instant = Date.parse('2026-11-01T06:30:00Z')
    expect(tiktokAccountDate(instant, 'America/Los_Angeles')).toBe('2026-10-31')
    expect(tiktokAccountDate(instant, 'Asia/Tokyo')).toBe('2026-11-01')
    expect(tiktokAccountDate(instant, 'UTC-07:00')).toBe('2026-10-31')
    expect(tiktokAccountDate(instant, 'GMT+05:30')).toBe('2026-11-01')
    expect(tiktokAccountDate(instant, 'UTC+14:01')).toBeNull()
    expect(tiktokAccountDate(instant, 'unknown/zone')).toBeNull()
  })
})

describe('today windows', () => {
  it('validates up to 366 calendar days and compares exactly across leap days and DST', () => {
    expect(parseTikTokCustomWindow('2024-01-01', '2024-12-31')).toEqual({ start: '2024-01-01', end: '2024-12-31' })
    expect(parseTikTokCustomWindow('2024-01-01', '2025-01-01')).toBeNull()
    expect(parseTikTokCustomWindow('2024-02-30', '2024-03-02')).toBeNull()
    expect(parseTikTokCustomWindow('2024-3-01', '2024-03-02')).toBeNull()
    expect(previousEqualWindow({ start: '2024-03-09', end: '2024-03-12' })).toEqual({ start: '2024-03-05', end: '2024-03-08' })
    expect(todayWindowForAccountDate('last7', '2026-10-31')).toEqual({ start: '2026-10-24', end: '2026-10-30' })
  })
  it('uses complete days and matches the Facebook last-7 preset', () => {
    expect(todayWindow('today', today)).toEqual({ start: '2026-10-01', end: '2026-10-01' })
    expect(todayWindow('last7', today)).toEqual(boardReadingRangeDates('last7', today))
    expect(todayWindow('last28', today)).toEqual({ start: '2026-09-03', end: '2026-09-30' })
    expect(todayWindowMatchesFbPreset('last7', today)).toBe(true)
    expect(fbPresetForTodayRange('last28')).toBeNull()
  })

  it('steps back by the same number of days', () => {
    expect(previousEqualWindow(todayWindow('last7', today))).toEqual({
      start: '2026-09-17',
      end: '2026-09-23'
    })
    expect(previousEqualWindow(todayWindow('today', today))).toEqual({
      start: '2026-09-30',
      end: '2026-09-30'
    })
  })

  it('gives the TikTok board ranges the same complete-day windows', () => {
    expect(tiktokReadingRangeWindow('1', today)).toEqual({ start: '2026-10-01', end: '2026-10-01' })
    expect(tiktokReadingRangeWindow('7', today)).toEqual(todayWindow('last7', today))
    expect(tiktokReadingRangeWindow('7', today)).toEqual(boardReadingRangeDates('last7', today))
    expect(tiktokReadingRangeWindow('28', today)).toEqual({ start: '2026-09-03', end: '2026-09-30' })
  })

  it('crosses month and year boundaries', () => {
    expect(tiktokReadingRangeWindow('7', new Date(2027, 0, 3))).toEqual({ start: '2026-12-27', end: '2027-01-02' })
  })

  it('writes a window as one date or a dated span', () => {
    expect(formatReadingWindow({ start: '2026-10-01', end: '2026-10-01' })).toBe('2026-10-01')
    expect(formatReadingWindow({ start: '2026-09-24', end: '2026-09-30' })).toBe('2026-09-24 – 2026-09-30')
  })
})

describe('today spend presentation', () => {
  it('formats a delta only when both windows exist', () => {
    expect(formatSpendDelta(120, 100)).toBe('+20.00')
    expect(formatSpendDelta(80, 100)).toBe('−20.00')
    expect(formatSpendDelta(10, null)).toBeNull()
  })

  it('ranks campaigns by how much spend moved', () => {
    const moves = topSpendMoves(
      [
        { name: 'A', spend: 50 },
        { name: 'B', spend: 40 }
      ],
      [
        { name: 'A', spend: 48 },
        { name: 'B', spend: 10 },
        { name: 'C', spend: 30 }
      ]
    )
    expect(moves.map((move) => move.name)).toEqual(['B', 'C', 'A'])
    expect(moves[0].delta).toBe(30)
    expect(moves[1].delta).toBe(-30)
  })
})

describe('buildTodayChatPrompt', () => {
  it('keeps missing figures missing', () => {
    const prompt = buildTodayChatPrompt('zh', '近7天', '2026-09-24 – 2026-09-30', [
      {
        platform: 'Facebook',
        name: '三国IOS',
        status: '还没有这个日期的核对',
        spend: null,
        delta: null,
        movers: []
      }
    ])
    expect(prompt).toContain('没有这个窗口的数')
    expect(prompt).toContain('没有上一窗口')
    expect(prompt).not.toContain('0.00')
  })
})
