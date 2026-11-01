import { describe, expect, it } from 'vitest'
import { createReadingModuleWidgets, readingModuleTemplate, validateReadingModuleSpec, type ReadingModuleSpec } from './readingModules'
import { renderHtmlBoard, type HtmlBoardDocument } from './htmlBoard'
import type { ReadingSnapshot, ReadingSnapshotAccount } from './readingSnapshot'

const baseAccount: ReadingSnapshotAccount = { platform: 'tiktok', accountId: 'SYNTHETIC_ID', name: 'Synthetic account', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null, sourceAt: 100, timezone: 'UTC', currency: 'USD', spend: 12, previousSpend: null, impressions: 100, clicks: 3, conversions: 1, resultType: 'SYNTHETIC_PRIVATE_RESULT' }
const snapshot = (accounts: ReadingSnapshotAccount[]): ReadingSnapshot => ({ kind: 'reading-snapshot', version: 1, rangeLabel: 'Synthetic', window: { start: '2026-01-01', end: '2026-01-07' }, capturedAt: 200, accounts })
const render = (source: ReadingSnapshot, spec: ReadingModuleSpec, anonymize = true): string => {
  const template = readingModuleTemplate(spec, source, 'en')
  const doc: HtmlBoardDocument = { schemaVersion: 1, id: 'synthetic', revision: 1, source: { boardId: 'board', widgetId: 'widget', snapshotHash: 'a'.repeat(64) }, snapshot: source, includeChart: false, mode: 'module', theme: 'minimal', ...template, createdAt: 200, updatedAt: 200 }
  return renderHtmlBoard(doc, { anonymize, language: 'en' })
}

describe('reading modules', () => {
  it('accepts only bounded, unambiguous specs tied to an existing account', () => {
    const source = snapshot([baseAccount])
    expect(validateReadingModuleSpec({ kind: 'metric', metric: 'spend', accountIndex: 0 }, source)).not.toBeNull()
    for (const bad of [
      { kind: 'metric', metric: 'spend' }, { kind: 'metric', metric: 'spend', accountIndex: 1 },
      { kind: 'metric', metric: 'spend', accountIndex: -1 }, { kind: 'metric', metric: 'spend', accountIndex: 0.5 },
      { kind: 'metric', metric: 'spend', accountIndex: 0, snapshot: source }, { kind: 'metric', metric: ['spend'], accountIndex: 0 },
      { kind: 'spend-chart', chart: 'line' }, { kind: 'spend-chart', chart: ['bar'] },
      { kind: 'note', text: 'x'.repeat(2001) }, { kind: 'coverage', text: 'extra' }
    ]) expect(validateReadingModuleSpec(bad, source)).toBeNull()
  })

  it('anonymizes unknown result definitions in conversion modules while escaping identified values', () => {
    const source = snapshot([{ ...baseAccount, resultType: 'SYNTHETIC_PRIVATE_RESULT <script>' }])
    const spec: ReadingModuleSpec = { kind: 'metric', metric: 'conversions', accountIndex: 0 }
    const anonymous = render(source, spec)
    expect(anonymous).toContain('Result type unknown')
    expect(anonymous).not.toContain('SYNTHETIC_PRIVATE_RESULT')
    expect(anonymous).not.toContain('SYNTHETIC_ID')
    expect(anonymous).not.toContain('Synthetic account')
    const identified = render(source, spec, false)
    expect(identified).toContain('SYNTHETIC_PRIVATE_RESULT &lt;script&gt;')
    expect(identified).not.toContain('<script>')
    const known = render(snapshot([{ ...baseAccount, resultType: 'App installs' }]), spec)
    expect(known).toContain('App installs')
  })

  it('keeps missing or failed metrics unknown and does not merge distinct currencies on charts', () => {
    const source = snapshot([
      { ...baseAccount, name: 'Dollar', spend: 12, currency: 'USD' },
      { ...baseAccount, name: 'Euro', spend: 17, currency: 'EUR' },
      { ...baseAccount, name: 'No currency', spend: 20, currency: null },
      { ...baseAccount, name: 'Failed', status: 'failed', currency: null, sourceAt: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }
    ])
    const failed = render(source, { kind: 'metric', metric: 'spend', accountIndex: 3 }, false)
    expect(failed).toContain('—')
    expect(failed).not.toContain('>0<')
    const chart = render(source, { kind: 'spend-chart', chart: 'bar' }, false)
    expect(chart).toContain('USD')
    expect(chart).toContain('EUR')
    expect(chart.match(/class="bar"/g)).toHaveLength(3)
    expect(chart).toContain('excluded')
  })

  it('creates independent non-overlapping cards and clones the saved snapshot', () => {
    const source = snapshot([baseAccount])
    const widgets = createReadingModuleWidgets(source, true, 'en')
    expect(widgets.some(widget => (widget.config.module as ReadingModuleSpec).kind === 'spend-chart')).toBe(true)
    for (const [index, a] of widgets.entries()) for (const b of widgets.slice(index + 1)) {
      const x = a.layout.x < b.layout.x + b.layout.w && b.layout.x < a.layout.x + a.layout.w
      const y = a.layout.y < b.layout.y + b.layout.h && b.layout.y < a.layout.y + a.layout.h
      expect(x && y).toBe(false)
    }
    source.accounts[0].name = 'Changed later'
    expect((widgets[0].config.snapshot as ReadingSnapshot).accounts[0].name).toBe('Synthetic account')
  })
})
