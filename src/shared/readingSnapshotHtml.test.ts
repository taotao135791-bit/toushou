import { describe, expect, it } from 'vitest'
import { readingSnapshotHtmlChartGroups, renderReadingSnapshotHtml } from './readingSnapshotHtml'
import type { ReadingSnapshot, ReadingSnapshotAccount } from './readingSnapshot'

const row = (overrides: Partial<ReadingSnapshotAccount> = {}): ReadingSnapshotAccount => ({ platform: 'tiktok', accountId: '999999999999999999', name: 'PrivateName', status: 'ok', statusDetail: 'private-detail', window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 1000, timezone: 'PrivateTimezone', currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 2, conversions: 1, ...overrides })
const make = (accounts: ReadingSnapshotAccount[]): ReadingSnapshot => ({ kind: 'reading-snapshot', version: 1, rangeLabel: 'Private range name', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 2000, accounts })

describe('standalone reading snapshot export', () => {
  it('anonymizes all free-text fields by default and keeps failure status, dates and missing figures', () => {
    const failed = row({ status: 'failed', statusDetail: 'private failure', spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null })
    const html = renderReadingSnapshotHtml(make([row(), failed]), { includeChart: true, title: 'Secret title' })
    for (const text of ['PrivateName', '999999999999999999', 'private-detail', 'private failure', 'PrivateTimezone', 'Private range name', 'Secret title']) expect(html).not.toContain(text)
    expect(html).toContain('账户 1')
    expect(html).toContain('账户 2')
    expect(html).toContain('失败')
    expect(html).toContain('2026-10-01')
    expect(html).toContain('USD')
    expect(html).toContain('—')
    expect(html).not.toMatch(/<(script|svg|iframe|img|link)\b/i)
    expect(html).not.toMatch(/\b(?:href|src)\s*=/i)
  })

  it('keeps each currency and unknown-currency account on its own scale, and never charts failed rows', () => {
    const snapshot = make([row({ spend: 10 }), row({ currency: 'EUR', spend: 20 }), row({ currency: null, spend: 30 }), row({ currency: null, spend: 40 }), row({ status: 'unattempted', spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null })])
    const groups = readingSnapshotHtmlChartGroups(snapshot)
    expect(groups).toHaveLength(4)
    expect(groups.map(group => group.entries.length)).toEqual([1, 1, 1, 1])
    const html = renderReadingSnapshotHtml(snapshot, { includeChart: true })
    expect(html.match(/class="bar"/g)).toHaveLength(4)
    expect(html).toContain('未尝试')
    expect(html).toContain('币种未知（单账户）')
  })

  it('escapes untrusted names, titles and details in explicitly identified exports', () => {
    const html = renderReadingSnapshotHtml(make([row({ name: '<script>alert("x")</script>', statusDetail: '<img src=x onerror=alert(1)>' })]), { anonymize: false, title: '<unsafe title>', language: 'en' })
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;unsafe title&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toMatch(/<(script|img|svg|iframe)\b/i)
    expect(html).toContain('999999999999999999')
  })

  it('shows whitelisted result semantics while preventing custom identifying labels in anonymous exports', () => {
    const snapshot = make([row({ resultType: 'App installs' }), row({ resultType: 'Purchases' }), row({ resultType: 'Private-result-identifier <img>' }), row({ resultType: null })])
    const anonymous = renderReadingSnapshotHtml(snapshot, { language: 'en' })
    expect(anonymous).toContain('App installs')
    expect(anonymous).toContain('Purchases')
    expect(anonymous).toContain('Result type unknown')
    expect(anonymous).not.toContain('Private-result-identifier')
    const identified = renderReadingSnapshotHtml(snapshot, { anonymize: false, language: 'en' })
    expect(identified).toContain('Private-result-identifier &lt;img&gt;')
    expect(identified).not.toContain('<img>')
  })

  it('rejects malformed input and cannot silently turn failed figures into zero', () => {
    const invalid = make([row({ status: 'failed', spend: 0 })])
    expect(() => renderReadingSnapshotHtml(invalid)).toThrow('invalid-snapshot')
  })
})
