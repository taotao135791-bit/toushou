import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlBoardTemplate, type HtmlBoardDocument } from '@shared/htmlBoard'

vi.mock('../../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (element: unknown) => element }))
import { HtmlBoardEditor, htmlBoardGenerationError } from './HtmlBoardEditor'

afterEach(() => vi.unstubAllGlobals())
const fixture: HtmlBoardDocument = {
  schemaVersion: 1, id: 'doc1', revision: 1, source: { boardId: 'board1', widgetId: 'widget1', snapshotHash: 'a'.repeat(64) }, includeChart: true,
  snapshot: { kind: 'reading-snapshot', version: 1, rangeLabel: 'test', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 1000,
    accounts: [{ platform: 'tiktok', accountId: '999999999999999999', name: 'Private Account', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 900, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] },
  ...htmlBoardTemplate('minimal', 'en'), createdAt: 1, updatedAt: 1
}

describe('offline HTML board editor', () => {
  it('starts with plain-language editing and an anonymous, sandboxed preview', () => {
    vi.stubGlobal('document', { body: {} })
    const html = renderToStaticMarkup(createElement(HtmlBoardEditor, { document: fixture, language: 'en', onSave: async () => ({ ok: false, error: 'write-failed' } as const), onExport: async () => ({ ok: false, error: 'cancelled' } as const), onGenerate: async () => ({ ok: false, error: 'unavailable' } as const), onCancel: async () => true, onClose: () => {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Change description"')
    expect(html).toContain('Your description, current layout and selected readings')
    expect(html).toContain('Generate suggestion')
    expect(html).toContain('Report style')
    expect(html).toContain('Apply layout template')
    expect(html).toContain('aria-label="Board title"')
    expect(html).toContain('aria-label="Period summary"')
    expect(html).toContain('aria-label="Next steps"')
    expect(html).toContain('Advanced: HTML / CSS')
    expect(html).not.toContain('aria-label="HTML"')
    expect(html).not.toContain('aria-label="CSS"')
    expect(html).toContain('sandbox=""')
    expect(html).toContain('Anonymize account data')
    expect(html).toContain('Custom content and values may still be sensitive')
    expect(html).not.toContain('Private Account')
    expect(html).not.toContain('999999999999999999')
  })
  it('explains unsupported model output without misreporting a connection failure', () => {
    const message = htmlBoardGenerationError('invalid-output', true)
    expect(message).toContain('格式暂不支持')
    expect(message).toContain('原内容和说明已保留')
    expect(message).not.toContain('连接')
    expect(htmlBoardGenerationError('invalid-output', false)).toContain('unsupported format')
    expect(htmlBoardGenerationError('cancelled', true)).toContain('已取消')
    expect(htmlBoardGenerationError('conflict', true)).toContain('其他窗口')
    expect(htmlBoardGenerationError('sensitive-content', true)).toContain('密钥')
  })
  it('keeps natural-language editing while hiding report-only controls for an independent module', () => {
    vi.stubGlobal('document', { body: {} })
    const module = { ...fixture, mode: 'module' as const, html: '<p>Metric</p><div data-reading-slot></div>', css: '' }
    const html = renderToStaticMarkup(createElement(HtmlBoardEditor, { document: module, language: 'en', onSave: async () => ({ ok: false, error: 'write-failed' } as const), onExport: async () => ({ ok: false, error: 'cancelled' } as const), onGenerate: async () => ({ ok: false, error: 'unavailable' } as const), onCancel: async () => true, onClose: () => {} }))
    expect(html).toContain('Change description')
    expect(html).toContain('Generate suggestion')
    expect(html).toContain('Advanced: HTML / CSS')
    expect(html).toContain('Offline preview')
    expect(html).not.toContain('Report style')
    expect(html).not.toContain('Apply layout template')
  })
  it('keeps non-template custom structures without forcing advanced editing', () => {
    vi.stubGlobal('document', { body: {} })
    const custom = { ...fixture, html: '<p class="custom">Keep this</p><div data-reading-slot></div>' }
    const html = renderToStaticMarkup(createElement(HtmlBoardEditor, { document: custom, language: 'en', onSave: async () => ({ ok: false, error: 'write-failed' } as const), onExport: async () => ({ ok: false, error: 'cancelled' } as const), onGenerate: async () => ({ ok: false, error: 'unavailable' } as const), onCancel: async () => true, onClose: () => {} }))
    expect(html).toContain('Your custom layout is preserved')
    expect(html).not.toContain('aria-label="HTML"')
    expect(html).toContain('Keep this')
    expect(html).not.toContain('aria-label="Board title"')
  })
})
