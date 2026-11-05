import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { metaAdsPreset } from '@shared/boards'
import { WidgetBody } from './WidgetBody'

describe('native Meta board metrics', () => {
  it('renders missing readings as unknown rather than zero or an embedded report', () => {
    const widget = metaAdsPreset(key => key)[0]
    const empty = renderToStaticMarkup(<WidgetBody widget={widget} datasets={[]} boardId="synthetic" onConfigChange={() => {}} />)
    expect(empty).toContain('—')
    expect(empty).not.toContain('<iframe')
    expect(empty).not.toContain('>0<')
    const zero = renderToStaticMarkup(<WidgetBody widget={{ ...widget, config: { source: 'manual', value: 0 } }} datasets={[]} boardId="synthetic" onConfigChange={() => {}} />)
    expect(zero).toContain('>0<')
  })
})
