import { describe, expect, it } from 'vitest'
import { htmlBoardTemplate, parseHtmlBoardTemplate, readHtmlBoardBasicFields, renderHtmlBoard, scopedHtmlBoardCss, updateHtmlBoardBasicField, type HtmlBoardDocument } from './htmlBoard'

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
    expect(html).toContain('Custom text and AI conclusions are not verified or automatically anonymized')
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
  it('edits plain text in all built-in layouts without treating input as markup', () => {
    for (const id of ['editorial', 'operations', 'minimal'] as const) {
      const original = htmlBoardTemplate(id).html
      expect(readHtmlBoardBasicFields(original)).toBeTruthy()
      const changed = updateHtmlBoardBasicField(original, 'title', '<script>alert(1)</script> & "Hello"')
      expect(changed).not.toBeNull()
      expect(changed).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp;')
      expect(changed).not.toContain('<script>')
      expect(readHtmlBoardBasicFields(changed!)?.title).toBe('<script>alert(1)</script> & "Hello"')
      const next = updateHtmlBoardBasicField(changed!, 'nextSteps', 'Review two accounts')
      expect(readHtmlBoardBasicFields(next!)?.nextSteps).toBe('Review two accounts')
      expect(parseHtmlBoardTemplate(next!)).toBeTruthy()
    }
  })
  it('preserves other custom structures, and refuses ambiguous or nested formatted fields', () => {
    const original = htmlBoardTemplate('editorial').html + '<aside class="custom"><strong>Keep this block</strong></aside>'
    const changed = updateHtmlBoardBasicField(original, 'summary', 'New summary')
    expect(changed).toContain('<aside class="custom"><strong>Keep this block</strong></aside>')
    expect(readHtmlBoardBasicFields(changed!)?.summary).toBe('New summary')
    const formatted = original.replace('<h1>投放读数周报</h1>', '<h1><em>Special title</em></h1>')
    expect(readHtmlBoardBasicFields(formatted)).toBeNull()
    expect(updateHtmlBoardBasicField(formatted, 'title', 'Replacement')).toBeNull()
    expect(formatted).toContain('<h1><em>Special title</em></h1>')
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
  it('binds immutable readings into authored layouts with safe anonymous defaults', () => {
    const d = document()
    d.snapshot = { ...snapshot, accounts: [{ ...snapshot.accounts[0], name: '<img src=x onerror=alert(1)>', spend: 12.5 }, { ...snapshot.accounts[0], name: 'Failed private', accountId: 'secret', status: 'failed', currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }] }
    d.html = '<section><span data-reading-value="1.account"></span><span class="metric" data-reading-value="1.spend"></span><span data-reading-value="2.spend"></span><span data-reading-value="2.currency"></span><span data-reading-value="2.status"></span><span data-reading-value="2.windowStart"></span></section><div data-reading-slot></div>'
    const anonymous = renderHtmlBoard(d, { language: 'en' })
    expect(anonymous).toContain('<span>Account 1</span><span class="metric">12.5</span><span>—</span><span>Unknown</span><span>Failed</span><span>2026-10-01</span>')
    expect(anonymous).not.toContain('Failed private')
    expect(anonymous).not.toContain('onerror=alert')
    expect(anonymous).not.toContain('data-reading-value')
    const identified = renderHtmlBoard(d, { language: 'en', anonymize: false })
    expect(identified).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(identified).not.toContain('<img src=x')
  })
  it('rejects invalid or forged bindings and out-of-range account references', () => {
    for (const html of [
      '<span data-reading-value="0.spend"></span>', '<span data-reading-value="01.spend"></span>',
      '<span data-reading-value="1.accountId"></span>', '<span data-reading-value="1.spend">fake</span>',
      '<span data-reading-value="1.spend"><b></b></span>', '<span data-reading-value="1.spend" title="fake"></span>',
      '<div data-reading-value="1.spend"></div>', '<span data-reading-value="1.spend" onclick="x"></span>'
    ]) expect(() => parseHtmlBoardTemplate(html + '<div data-reading-slot></div>'), html).toThrow()
    const d = document(); d.html = '<span data-reading-value="2.spend"></span><div data-reading-slot></div>'
    expect(() => renderHtmlBoard(d)).toThrow()
  })
  it('supports a 50th account binding while preserving unattempted status and unknown values', () => {
    const d = document()
    d.snapshot = { ...snapshot, accounts: Array.from({ length: 50 }, () => ({ ...snapshot.accounts[0], status: 'unattempted' as const, currency: null, spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null })) }
    d.html = '<span data-reading-value="50.account"></span><span data-reading-value="50.status"></span><span data-reading-value="50.clicks"></span><div data-reading-slot></div>'
    expect(renderHtmlBoard(d)).toContain('<span>账户 50</span><span>未尝试</span><span>—</span>')
  })
  it('uses trusted snapshot charts even when the main report chart is disabled', () => {
    const d = document()
    d.includeChart = false
    d.snapshot = { ...snapshot, accounts: [
      { ...snapshot.accounts[0], currency: 'USD', spend: 20 },
      { ...snapshot.accounts[0], accountId: '2', currency: 'EUR', spend: 10 },
      { ...snapshot.accounts[0], accountId: '3', currency: null, spend: 5 },
      { ...snapshot.accounts[0], accountId: '4', currency: null, spend: 2 },
      { ...snapshot.accounts[0], accountId: '5', status: 'failed', spend: null, previousSpend: null, impressions: null, clicks: null, conversions: null }
    ] }
    d.html = '<div data-reading-chart="spend"></div><div data-reading-slot></div><div data-reading-chart="spend"></div>'
    const html = renderHtmlBoard(d, { language: 'en' })
    expect(html.match(/Account spend \(separate platform and currency groups\)/g)).toHaveLength(2)
    expect(html.match(/TikTok · USD/g)).toHaveLength(2)
    expect(html.match(/TikTok · EUR/g)).toHaveLength(2)
    expect(html.match(/Currency unknown \(one account\)/g)).toHaveLength(4)
    expect(html.match(/class="bar"/g)).toHaveLength(8)
    expect(html).not.toContain('Private Account')
    expect(html).not.toContain('data-reading-chart')
    expect(html).not.toContain('<svg')
  })
  it('rejects untrusted or excessive chart markers', () => {
    for (const html of [
      '<span data-reading-chart="spend"></span>', '<div data-reading-chart="clicks"></div>',
      '<div data-reading-chart="spend">fake</div>', '<div data-reading-chart="spend" class="fake"></div>',
      '<div data-reading-chart="spend"></div>'.repeat(3)
    ]) expect(() => parseHtmlBoardTemplate(html + '<div data-reading-slot></div>'), html).toThrow()
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
