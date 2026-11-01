import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BoardHighlightsProposalBlock from './BoardHighlightsProposalBlock'

const raw = JSON.stringify({ version: 1, boardId: '11111111-1111-4111-8111-111111111111', widgetId: '22222222-2222-4222-8222-222222222222', revision: `sha256:${'a'.repeat(64)}`, highlights: [{ text: 'Review the account', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }] }] })
afterEach(() => vi.unstubAllGlobals())
describe('highlight proposal review', () => {
  it('renders a reviewable proposal with apply and evidence navigation disabled until checked', () => {
    const validate = vi.fn(), apply = vi.fn()
    vi.stubGlobal('window', { electronAPI: { validateBoardHighlights: validate, applyBoardHighlights: apply } })
    const html = renderToStaticMarkup(<MemoryRouter><BoardHighlightsProposalBlock raw={raw} /></MemoryRouter>)
    expect(html).toContain('Review the account')
    expect(html).toContain('disabled=""')
    expect(html).toMatch(/confirm|确认/i)
    expect(validate).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })
  it('rejects malformed proposals without offering apply', () => {
    vi.stubGlobal('window', { electronAPI: {} })
    const html = renderToStaticMarkup(<MemoryRouter><BoardHighlightsProposalBlock raw="not JSON" /></MemoryRouter>)
    expect(html).toMatch(/incomplete|不完整/i)
    expect(html).not.toMatch(/confirm and add|确认并加入/i)
  })
  it('does not require a browser bridge merely to render a proposal', () => {
    vi.unstubAllGlobals()
    const html = renderToStaticMarkup(<MemoryRouter><BoardHighlightsProposalBlock raw={raw} /></MemoryRouter>)
    expect(html).toContain('Review the account')
    expect(html).toContain('disabled=""')
  })
})
