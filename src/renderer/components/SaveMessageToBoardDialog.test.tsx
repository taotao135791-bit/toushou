import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortal } from 'react-dom'
import { useModalBoundary } from '../lib/modalBoundary'
import { SaveMessageToBoardDialog } from './SaveMessageToBoardDialog'

vi.mock('react-dom', () => ({ createPortal: vi.fn(element => element) }))
vi.mock('../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('chat save dialog outside transcript containment', () => {
  it('portals to the body and registers the shared modal boundary', () => {
    const body = {}
    vi.stubGlobal('document', { body })
    const close = vi.fn()
    const saved = vi.fn()
    const html = renderToStaticMarkup(<SaveMessageToBoardDialog content="Synthetic note" onClose={close} onSaved={saved} />)
    expect(vi.mocked(createPortal).mock.calls[0][1]).toBe(body)
    expect(vi.mocked(useModalBoundary).mock.calls[0][1]).toBe(true)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('max-h-[calc(100dvh-32px)]')
    expect(html).toContain('min-h-0 flex-1 overflow-y-auto')
    expect(html).toContain('<header class="flex shrink-0')
    expect(html).toContain('<footer class="flex shrink-0')
    const escape = vi.mocked(useModalBoundary).mock.calls[0][2]!
    escape()
    escape()
    expect(close).toHaveBeenCalledTimes(1)
    expect(saved).not.toHaveBeenCalled()
  })

  it('can render without a document without invoking a portal or opening a browser boundary', () => {
    const html = renderToStaticMarkup(<SaveMessageToBoardDialog content="Synthetic note" onClose={() => {}} onSaved={() => {}} />)
    expect(createPortal).not.toHaveBeenCalled()
    expect(vi.mocked(useModalBoundary).mock.calls[0][1]).toBe(false)
    expect(html).toContain('role="dialog"')
  })
})
