import { describe, expect, it } from 'vitest'
import { htmlBoardTemplate, parseHtmlBoardTemplate, renderHtmlBoard, scopedHtmlBoardCss, type HtmlBoardDocument } from './htmlBoard'

const snapshot = { kind: 'reading-snapshot' as const, version: 1 as const, rangeLabel: '7 days', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 1000, accounts: [{ platform: 'tiktok' as const, accountId: '999999999999999999', name: 'Private Account', status: 'ok' as const, statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 900, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] }
function document(template: 'editorial' | 'operations' | 'minimal' = 'editorial'): HtmlBoardDocument {
  return { schemaVersion: 1, id: 'doc1', revision: 1, source: { boardId: 'board1', widgetId: 'widget1', snapshotHash: 'a'.repeat(64) }, snapshot, includeChart: true, ...htmlBoardTemplate(template), createdAt: 1, updatedAt: 1 }
}

describe('offline HTML board templates', () => {
  it('provides three editable styles around one immutable, anonymous snapshot', () => {
    const outputs = (['editorial', 'operations', 'minimal'] as const).map(id => renderHtmlBoard(document(id)))
    expect(new Set(outputs).size).toBe(3)
    for (const html of outputs) {
      expect(html).toContain('账户 1')
      expect(html).not.toContain('Private Account')
      expect(html).not.toContain('999999999999999999')
      expect(html).toContain("default-src 'none'")
      expect(html).not.toMatch(/<(script|svg|iframe|img|link)\b/i)
      expect(html).not.toMatch(/\b(?:href|src)\s*=/i)
    }
  })
  it('parses and scopes author HTML and CSS without letting selectors target report data', () => {
    const d = document()
    d.html = '<header class="custom"><h1>Custom text</h1></header><div data-reading-slot></div><section class="note"><p>Editable notes</p></section>'
    d.css = '.custom, .note p { color: #123456; display: block; padding: 10px; }'
    const html = renderHtmlBoard(d, { language: 'en' })
    expect(html).toContain('Custom text')
    expect(html).toContain('Editable notes')
    expect(html).toContain('#html-board-custom-before .custom')
    expect(html).toContain('#html-board-custom-after .note p')
    expect(html).toContain('Custom HTML/CSS, including text, attributes and comments')
    expect(html.indexOf('Custom text')).toBeLessThan(html.indexOf('Account 1'))
    expect(html.indexOf('Account 1')).toBeLessThan(html.indexOf('Editable notes'))
  })
  it('changes only the trusted report palette and typography using bounded styles', () => {
    const d = document()
    const editorial = renderHtmlBoard({ ...d, theme: 'editorial' })
    const operations = renderHtmlBoard({ ...d, theme: 'operations' })
    const minimal = renderHtmlBoard({ ...d, theme: 'minimal' })
    expect(editorial).toContain('main .bar{background:#a55d32}')
    expect(operations).toContain('main .bar{background:#197c86}')
    expect(minimal).toContain('main .bar{background:#333333}')
    for (const html of [editorial, operations, minimal]) expect(html).toContain('账户 1')
    expect(() => renderHtmlBoard({ ...d, theme: 'untrusted-style' })).toThrow()
  })
  it('requires exactly one empty, top-level slot and rejects dangerous HTML trees', () => {
    for (const html of [
      '<p>no slot</p>', '<div data-reading-slot></div><div data-reading-slot></div>',
      '<section><div data-reading-slot></div></section>', '<div data-reading-slot><p>fake</p></div>',
      '<script>alert(1)</script><div data-reading-slot></div>', '<img src="https://example.invalid/a"><div data-reading-slot></div>',
      '<div onerror="alert(1)"></div><div data-reading-slot></div>', '<svg><script>alert(1)</script></svg><div data-reading-slot></div>',
      '<iframe srcdoc="<script>x</script>"></iframe><div data-reading-slot></div>', '<div style="background:url(https://example.invalid)"></div><div data-reading-slot></div>',
      '<a href="javascript:alert(1)">x</a><div data-reading-slot></div>', '<form><input></form><div data-reading-slot></div>'
    ]) expect(() => parseHtmlBoardTemplate(html), html).toThrow()
  })
  it('rejects CSS network access, escaping, out-of-scope selectors and layout overlays', () => {
    for (const css of [
      '@import "https://example.invalid/x";', '.x { background: url(https://example.invalid); }',
      '.x { background: u\\72l(https://example.invalid); }', '.x { background-image: image-set(url(x) 1x); }',
      '.x { position: fixed; }', '.x { margin-top: -1px; }', '.x + body { color: red; }', '#html-board-custom-before { display: none; }',
      '.x { content: "fake"; }', '.x { color: var(--private); }', '.x { color: red !important; }',
      '.x { color: red; } </style><script>x</script>', '.x { width: 1e100px; }'
    ]) expect(() => scopedHtmlBoardCss(css), css).toThrow()
  })
})
