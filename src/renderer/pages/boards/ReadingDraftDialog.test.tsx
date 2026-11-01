import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))
import { ReadingDraftDialog } from './ReadingDraftDialog'

describe('ReadingDraftDialog', () => {
  it('shows the local campaign mapping outside the copied draft', () => {
    const html = renderToStaticMarkup(createElement(ReadingDraftDialog, {
      title: 'Review', language: 'en', value: 'Campaign A: 2', copyState: null,
      localMappings: [{ label: 'Campaign A', name: 'Private campaign' }],
      onChange: () => {}, onClose: () => {}, onCopy: () => {}
    }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('shown locally; not copied or sent')
    expect(html).toContain('Private campaign')
    expect(html.match(/<textarea[^>]*>(.*?)<\/textarea>/s)?.[1]).toBe('Campaign A: 2')
  })
})
