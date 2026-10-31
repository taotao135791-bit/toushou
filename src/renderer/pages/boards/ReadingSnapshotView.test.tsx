import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReadingSnapshotView, snapshotChartGroups } from './ReadingSnapshotView'
import type { ReadingSnapshot, ReadingSnapshotAccount } from '@shared/readingSnapshot'

const row = (overrides: Partial<ReadingSnapshotAccount> = {}): ReadingSnapshotAccount => ({ platform: 'tiktok', accountId: '123456', name: '<script>private</script>', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null, sourceAt: 1, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 2, clicks: 1, conversions: 0, ...overrides })
const make = (accounts: ReadingSnapshotAccount[]): ReadingSnapshot => ({ kind: 'reading-snapshot', version: 1, rangeLabel: '7 days', window: { start: '2026-01-01', end: '2026-01-07' }, capturedAt: 2, accounts })

describe('snapshot view', () => {
  it('separates different currencies and does not compare unknown currencies', () => {
    const snapshot = make([row(), row({ currency: 'EUR' }), row({ platform: 'facebook', currency: 'USD' }), row({ currency: null }), row({ currency: null }), row({ status: 'failed', spend: null })])
    const groups = snapshotChartGroups(snapshot)
    expect(groups).toHaveLength(5)
    expect(groups.every(group => group.rows.length === 1)).toBe(true)
  })
  it('renders a safe HTML table and anonymizes account identifiers and failure details', () => {
    const snapshot = make([row({ timezone: 'PRIVATE_TIMEZONE' }), row({ status: 'failed', statusDetail: 'PRIVATE_FAILURE_DETAIL', spend: null, name: 'Other', accountId: '987654' })])
    snapshot.rangeLabel = 'PRIVATE_RANGE'
    const html = renderToStaticMarkup(<ReadingSnapshotView snapshot={snapshot} includeChart language="zh" anonymous />)
    expect(html).toContain('<table')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('123456')
    expect(html).not.toContain('987654')
    expect(html).not.toContain('PRIVATE_FAILURE_DETAIL')
    expect(html).not.toContain('PRIVATE_TIMEZONE')
    expect(html).not.toContain('PRIVATE_RANGE')
    expect(html).not.toContain('private')
    expect(html).toContain('账户 1')
    expect(html).toContain('失败')
  })
  it('escapes names even in non-anonymous previews', () => {
    const html = renderToStaticMarkup(<ReadingSnapshotView snapshot={make([row()])} includeChart={false} />)
    expect(html).toContain('&lt;script&gt;private&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
})
