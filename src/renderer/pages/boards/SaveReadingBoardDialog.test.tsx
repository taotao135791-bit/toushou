import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReadingSnapshot } from '@shared/readingSnapshot'
import { SaveReadingBoardDialog } from './SaveReadingBoardDialog'

vi.mock('../../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))
const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'Fixture', window: { start: '2026-10-01', end: '2026-10-02' }, capturedAt: 1, accounts: [{ platform: 'tiktok', accountId: '123', name: 'Fixture', status: 'ok', statusDetail: null, window: { start: '2026-10-01', end: '2026-10-02' }, previousWindow: null, sourceAt: 1, timezone: 'UTC', currency: 'USD', spend: 10, previousSpend: null, impressions: 20, clicks: 3, conversions: 1 }] }
describe('saving reading boards', () => {
  it('defaults to a new modular board with charts, while offering the full report layout', () => {
    const html = renderToStaticMarkup(<SaveReadingBoardDialog snapshot={snapshot} language="en" onClose={() => {}} onSaved={() => {}} />)
    expect(html).toMatch(/type="radio" name="reading-destination" checked=""\/>New board/)
    expect(html).toMatch(/type="radio" name="reading-presentation" checked=""\/>Modular board/)
    expect(html).toContain('Full report')
    expect(html).toContain('Existing board')
    expect(html).toMatch(/type="checkbox" checked=""\/>Include account spend visualization/)
  })
})
