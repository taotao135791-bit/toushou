import { describe, expect, it } from 'vitest'
import { boardReadingRangeDates } from '../fbReading'
import {
  buildTodayChatPrompt,
  fbPresetForTodayRange,
  formatReadingWindow,
  formatSpendDelta,
  previousEqualWindow,
  tiktokReadingRangeWindow,
  todayWindow,
  todayWindowMatchesFbPreset,
  topSpendMoves
} from '../todayReading'

const today = new Date(2026, 9, 1) // local 2026-10-01

describe('today windows', () => {
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
