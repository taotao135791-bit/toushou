import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { chartScale, HtmlChart, type HtmlChartPoint } from './HtmlChart'

const p = (value: number, rest: Partial<HtmlChartPoint> = {}): HtmlChartPoint => ({ value, forecast: false, lo: null, hi: null, ...rest })

describe('HTML charts', () => {
  it('keeps the zero baseline in negative-only bars and fits signed values', () => {
    const negative = chartScale([p(-10), p(-5)], true)
    expect(negative.min).toBe(-10)
    expect(negative.max).toBe(0)
    expect(negative.y(0)).toBe(0)
    expect(negative.y(-10)).toBe(100)
    const mixed = chartScale([p(-20), p(40)], true)
    expect(mixed.y(0)).toBeCloseTo(200 / 3)
    const empty = chartScale([p(0)], true)
    expect(Number.isFinite(empty.y(0))).toBe(true)
  })
  it('includes forecast bounds and preserves exact values in an accessible table', () => {
    const points = [p(10), p(20, { forecast: true, lo: 5, hi: 30 })]
    expect(chartScale(points, false)).toMatchObject({ min: 5, max: 30 })
    for (const bar of [true, false]) {
      const html = renderToStaticMarkup(<HtmlChart points={points} labels={['Observed', 'Projected']} bar={bar} title="Spend" scope="2026-10-01 – 2026-10-02" currency="USD" forecastLabel="Forecast" showValues />)
      expect(html).toContain('<table')
      expect(html).toContain('5 – 30')
      expect(html).toContain('Forecast')
      expect(html).toContain('USD')
      expect(html).toContain('tabindex="0"')
      expect(html).not.toMatch(/<(svg|script|canvas)\b/)
    }
  })
})
