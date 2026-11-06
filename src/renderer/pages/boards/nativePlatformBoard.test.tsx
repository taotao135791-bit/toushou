import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { metaAdsPreset } from '@shared/boards'
import { WidgetBody } from './WidgetBody'
import { publishMetaReading } from './metaReadingStore'
import type { MetaReadingSummary } from '@shared/metaReading'

describe('native Meta board metrics', () => {
  it('explains that relative date ranges follow the computer calendar, not necessarily the account day', () => {
    const reader = metaAdsPreset(key => key)[0]
    const html = renderToStaticMarkup(<WidgetBody widget={reader} datasets={[]} boardId="synthetic" onConfigChange={() => {}} />)
    expect(html).toContain('Date ranges use this computer’s calendar')
    expect(html).toContain('may differ from today in the account timezone')
    expect(html).toContain('unverified')
  })
  it('renders missing readings as unknown rather than zero or an embedded report', () => {
    const widget = { ...metaAdsPreset(key => key)[1], config: { source: 'manual', value: null } }
    const empty = renderToStaticMarkup(<WidgetBody widget={widget} datasets={[]} boardId="synthetic" onConfigChange={() => {}} />)
    expect(empty).toContain('—')
    expect(empty).not.toContain('<iframe')
    expect(empty).not.toContain('>0<')
    const zero = renderToStaticMarkup(<WidgetBody widget={{ ...widget, config: { source: 'manual', value: 0 } }} datasets={[]} boardId="synthetic" onConfigChange={() => {}} />)
    expect(zero).toContain('>0<')
  })
  it('links real reader rows to isolated native cards, and clears them on refresh failure or disconnect', () => {
    const widgets = metaAdsPreset(key => key)
    const other = metaAdsPreset(key => key)
    const reader = widgets[0]
    const summary: MetaReadingSummary = { account: { id: 'act_123', name: 'Synthetic', currency: 'USD', timezone: null }, range: 'last3', start: '2026-01-01', end: '2026-01-02', readAt: 100,
      rows: [{ date: '2026-01-01', spend: 12, clicks: 2, impressions: 100 }, { date: '2026-01-02', spend: 30, clicks: null, impressions: 200 }] }
    const render = (index: number, source = widgets) => renderToStaticMarkup(<WidgetBody widget={source[index]} datasets={[]} boardId="synthetic" onConfigChange={() => {}} masterWindow={{ start: '2026-12-31', end: '2026-12-31' }} />)
    try {
      publishMetaReading(reader.id, summary)
      expect(render(1)).toContain('>42<')
      expect(render(2)).toContain('>300<')
      // A missing daily metric cannot become a partial total.
      expect(render(3)).not.toContain('>2<')
      expect(render(1, other)).not.toContain('>42<')
      publishMetaReading(reader.id, null)
      expect(render(1)).not.toContain('>42<')
    } finally { publishMetaReading(reader.id, null) }
  })
})
