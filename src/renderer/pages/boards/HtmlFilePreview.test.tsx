import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HtmlFilePreview } from './HtmlFilePreview'

vi.mock('../../lib/modalBoundary', () => ({ useModalBoundary: vi.fn() }))

describe('HTML file and reading-module previews', () => {
  it('offers a full-size view while keeping the existing file sandbox', () => {
    const markup = renderToStaticMarkup(<HtmlFilePreview html="<p>fixture content</p>" title="Fixture" language="en" />)
    expect(markup).toContain('Open full preview')
    expect(markup).toContain('Scroll inside the preview')
    expect(markup).toContain('sandbox="allow-scripts"')
    expect(markup).toContain('&lt;p&gt;fixture content&lt;/p&gt;')
  })
  it('keeps trusted reading-module preview scripts disabled and places controls together', () => {
    const markup = renderToStaticMarkup(<HtmlFilePreview html="<p>metric</p>" title="Metric" language="en" allowScripts={false} compact toolbarActions={<><button>Edit</button><button>Export</button></>} />)
    expect(markup).toContain('sandbox=""')
    expect(markup).not.toContain('sandbox="allow-scripts"')
    expect(markup).toContain('Open full preview')
    expect(markup).toMatch(/<button>Edit<\/button><button>Export<\/button><button[^>]*>Open full preview<\/button>/)
    expect(markup).not.toContain('Scroll inside the preview')
  })
})
