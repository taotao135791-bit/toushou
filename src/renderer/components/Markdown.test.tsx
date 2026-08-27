import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { extensionExternalLinkMessage } from '../../main/omp/extensionLinks'
import Markdown from './Markdown'

describe('Markdown links', () => {
  it('render as external-browser links rather than in-window navigation', () => {
    const html = renderToStaticMarkup(<Markdown content="[Open docs](https://example.com/docs)" />)

    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('cannot turn extension-controlled URL punctuation into a second link', () => {
    const content = extensionExternalLinkMessage(
      'https://example.com/one) [misleading](https://evil.example)'
    )
    const html = renderToStaticMarkup(<Markdown content={content ?? ''} />)

    expect(html.match(/<a\b/g)).toHaveLength(1)
    expect(html).toContain('href="https://example.com/one%29%20%5Bmisleading%5D%28https://evil.example%29"')
  })
})
