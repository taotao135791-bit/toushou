import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlBoardTemplate, type HtmlBoardDocument } from '@shared/htmlBoard'

vi.mock('../../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (element: unknown) => element }))
import { HtmlBoardEditor } from './HtmlBoardEditor'

afterEach(() => vi.unstubAllGlobals())
const fixture: HtmlBoardDocument = {
  schemaVersion: 1, id: 'doc1', revision: 1, source: { boardId: 'board1', widgetId: 'widget1', snapshotHash: 'a'.repeat(64) }, includeChart: true,
  snapshot: { kind: 'reading-snapshot', version: 1, rangeLabel: 'test', window: { start: '2026-10-01', end: '2026-10-07' }, capturedAt: 1000,
    accounts: [{ platform: 'tiktok', accountId: '999999999999999999', name: 'Private Account', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-07' }, previousWindow: null, sourceAt: 900, timezone: null, currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] },
  ...htmlBoardTemplate('minimal', 'en'), createdAt: 1, updatedAt: 1
}

describe('offline HTML board editor', () => {
  it('renders actual HTML/CSS editors and an anonymous, sandboxed preview', () => {
    vi.stubGlobal('document', { body: {} })
    const html = renderToStaticMarkup(createElement(HtmlBoardEditor, { document: fixture, language: 'en', onSave: async () => ({ ok: false, error: 'write-failed' } as const), onExport: async () => ({ ok: false, error: 'cancelled' } as const), onClose: () => {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="HTML"')
    expect(html).toContain('aria-label="CSS"')
    expect(html).toContain('sandbox=""')
    expect(html).toContain('Anonymize account data')
    expect(html).toContain('attributes, comments, and values')
    expect(html).not.toContain('Private Account')
    expect(html).not.toContain('999999999999999999')
  })
})
