import { describe, it, expect } from 'vitest'
import { forecastSeries, type ForecastSeriesPoint } from './forecast'

/** Daily points for 2026-01-01 onward with the given values. */
function daily(values: number[]): ForecastSeriesPoint[] {
  return values.map((value, i) => {
    const day = String(i + 1).padStart(2, '0')
    return { label: `2026-01-${day}`, value }
  })
}

describe('forecastSeries', () => {
  it('continues an upward trend', () => {
    // p10/p90 damping shaves the ramp's end values a little, so the slope is
    // slightly flatter than 1/day; the projection still lands on the trend.
    const out = forecastSeries(daily([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), 7)
    expect(out).toHaveLength(7)
    expect(Math.abs(out[0].value - 15)).toBeLessThan(1.5)
    expect(Math.abs(out[6].value - 21)).toBeLessThan(1.5)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].value).toBeGreaterThan(out[i - 1].value)
    }
    expect(out.every((p) => p.forecast === true)).toBe(true)
    expect(out.every((p) => p.lo <= p.value && p.value <= p.hi)).toBe(true)
  })

  it('continues a downward trend', () => {
    const out = forecastSeries(daily([28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15]), 5)
    expect(Math.abs(out[0].value - 14)).toBeLessThan(1.5)
    expect(Math.abs(out[4].value - 10)).toBeLessThan(1.5)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].value).toBeLessThan(out[i - 1].value)
    }
  })

  it('projects a constant series flat with a tiny band', () => {
    const out = forecastSeries(daily([250, 250, 250, 250, 250, 250, 250, 250, 250, 250]), 3)
    expect(out).toHaveLength(3)
    for (const p of out) {
      expect(p.value).toBe(250)
      expect(p.hi - p.lo).toBeLessThan(1e-3)
      expect(p.lo).toBeLessThanOrEqual(p.value)
      expect(p.hi).toBeGreaterThanOrEqual(p.value)
    }
  })

  it('returns empty for short series, garbage input and bad horizons', () => {
    expect(forecastSeries([], 7)).toEqual([])
    expect(forecastSeries(daily([1, 2, 3]), 7)).toEqual([])
    expect(forecastSeries(daily([1, 2, 3, Number.NaN]), 7)).toEqual([])
    // Exactly four valid points is the minimum.
    expect(forecastSeries(daily([1, 2, 3, 4]), 1)).toHaveLength(1)
    expect(forecastSeries(daily([1, 2, 3, 4]), 0)).toEqual([])
    expect(forecastSeries(daily([1, 2, 3, 4]), -3)).toEqual([])
    expect(forecastSeries(daily([1, 2, 3, 4]), Number.NaN)).toEqual([])
    expect(forecastSeries(daily([1, 2, 3, 4]), 2.9)).toHaveLength(2)
  })

  it('damps a spend spike instead of chasing it', () => {
    const base = [100, 102, 99, 101, 100, 103, 98, 100, 102, 101, 99, 100, 102, 100]
    const spiky = [...base]
    spiky[3] = 9000
    const out = forecastSeries(daily(spiky), 3)
    for (const p of out) {
      // Undamped, a 9000 spike inside a 14-point window would drag the fit
      // far above the ~100 level; clipping to [p10, p90] neutralizes it.
      expect(Math.abs(p.value - 100)).toBeLessThan(5)
    }
    // The clean series forecasts the same level within a small tolerance.
    const clean = forecastSeries(daily(base), 1)
    expect(Math.abs(clean[0].value - out[0].value)).toBeLessThan(2)
  })

  it('fits only the last 14 points of a longer series', () => {
    // Six days at 0, then 14 days of 100..113: the window is exactly the
    // recent 14, so the next day lands back on ~114 (not the all-20 fit).
    const values = [0, 0, 0, 0, 0, 0, ...Array.from({ length: 14 }, (_, i) => 100 + i)]
    const out = forecastSeries(daily(values), 1)
    expect(Math.abs(out[0].value - 114)).toBeLessThan(1)
  })

  it('filters non-numeric values before fitting', () => {
    const mixed: ForecastSeriesPoint[] = [
      { label: '2026-01-01', value: 10 },
      { label: '2026-01-02', value: Number.NaN },
      { label: '2026-01-03', value: 20 },
      { label: '2026-01-04', value: Infinity },
      { label: '2026-01-05', value: 30 },
      { label: '2026-01-06', value: 40 },
      { label: '2026-01-07', value: 50 },
      { label: '2026-01-08', value: 60 }
    ]
    const out = forecastSeries(mixed, 1)
    expect(out).toHaveLength(1)
    // Valid points 10..60 lie on a +10/day line; symmetric p10/p90 clipping
    // preserves the level, so the next day continues to ~65.
    expect(Math.abs(out[0].value - 65)).toBeLessThan(1)
    expect(out[0].label).toBe('2026-01-09')
    // Too few valid points after filtering -> no forecast.
    expect(
      forecastSeries(
        [
          { label: '2026-01-01', value: 1 },
          { label: '2026-01-02', value: Number.NaN },
          { label: '2026-01-03', value: Number.NaN },
          { label: '2026-01-04', value: 4 }
        ],
        3
      )
    ).toEqual([])
  })

  it('continues daily YYYY-MM-DD labels from the last point', () => {
    const out = forecastSeries(daily([1, 2, 3, 4, 5, 6, 7]), 4)
    expect(out.map((p) => p.label)).toEqual([
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11'
    ])
  })

  it('normalizes non-canonical date labels and falls back without one', () => {
    const slash: ForecastSeriesPoint[] = [
      { label: '2026/2/3', value: 1 },
      { label: '2026/2/4', value: 2 },
      { label: '2026/2/5', value: 3 },
      { label: '2026/2/6', value: 4 },
      { label: '2026/2/7', value: 5 }
    ]
    expect(forecastSeries(slash, 2).map((p) => p.label)).toEqual(['2026-02-08', '2026-02-09'])

    const undated: ForecastSeriesPoint[] = [
      { label: 'Mon', value: 1 },
      { label: 'Tue', value: 2 },
      { label: 'Wed', value: 3 },
      { label: 'Thu', value: 4 },
      { label: 'Fri', value: 5 }
    ]
    expect(forecastSeries(undated, 3).map((p) => p.label)).toEqual(['+1 d', '+2 d', '+3 d'])
  })

  it('emits a symmetric ~80% band around each prediction', () => {
    const out = forecastSeries(daily([10, 14, 9, 16, 11, 15, 8, 13, 12, 10, 14, 11]), 2)
    for (const p of out) {
      expect(p.hi - p.value).toBeCloseTo(p.value - p.lo, 10)
      expect(p.hi).toBeGreaterThan(p.value)
      expect(p.lo).toBeLessThan(p.value)
    }
  })

  it('is pure: the input series is left untouched', () => {
    const input = daily([1, 2, 3, 4, 5])
    const snapshot = input.map((p) => ({ ...p }))
    forecastSeries(input, 3)
    expect(input).toEqual(snapshot)
    expect(forecastSeries(input, 3)).toEqual(forecastSeries(input, 3))
  })
})
