import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { extensionExternalLinkMessage } from '../../main/omp/extensionLinks'
import Markdown from './Markdown'

describe('Markdown links', () => {
  it('folds model HTML as escaped code without creating a preview or executing it', () => {
    const html = renderToStaticMarkup(<Markdown content={'```html\n<img src=x onerror=alert(1)>\n```'} />)
    expect(html).toContain('<details')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
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

describe('chat attachments in Markdown', () => {
  it.each([
    ['[**查看**成片](sandbox:/mnt/data/clip%20v6.mp4)', 'clip v6.mp4', '查看成片'],
    ['![示例视频 第六版](sandbox:/mnt/data/video.mp4)', 'video.mp4', '示例视频 第六版'],
    ['[日报](<file:///Users/test/Downloads/Q4%20(17).csv>)', 'Q4 (17).csv', '日报'],
    ['`/Users/test/Downloads/投放日报 (17).csv`', '投放日报 (17).csv', 'CSV'],
    ['`C:\\Users\\test\\Downloads\\投放日报 (17).csv`', '投放日报 (17).csv', 'CSV'],
    ['[旧 Windows 附件](<C:\\Users\\test\\Downloads\\报告 (1).xlsx>)', '报告 (1).xlsx', '旧 Windows 附件'],
    ['`reports/Weekly report (1).csv`', 'Weekly report (1).csv', 'CSV'],
    ['`reports/广告日报.xlsx`', '广告日报.xlsx', 'XLSX'],
    ['`report.pdf`', 'report.pdf', 'PDF']
  ])('renders a named file card with a separate save action for %s', (input, name, text) => {
    const html = renderToStaticMarkup(<Markdown content={input} />)
    expect(html.match(/<button\b/g)).toHaveLength(2)
    expect(html).toContain(name)
    expect(html).toContain(text)
  })

  it('opens a remote photo from its preview and keeps a linked photo inside its existing destination', () => {
    const html = renderToStaticMarkup(<Markdown content={'![照片](https://example.com/photo.jpg)\n\n[![封面](https://example.com/thumb.png)](https://example.com/docs)'} />)
    expect(html.match(/<a\b/g)).toHaveLength(2)
    expect(html).toContain('href="https://example.com/photo.jpg"')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).not.toContain('href="https://example.com/thumb.png"')
  })

  it('keeps code examples as text and a linked thumbnail as one clickable target', () => {
    const html = renderToStaticMarkup(<Markdown content={'```sh\n/tmp/report.csv\n```\n\n`cat report.csv`\n\n[![封面](./thumb.jpg)](https://example.com/docs)'} />)
    expect(html).toContain('<code>/tmp/report.csv</code>')
    expect(html).toContain('<code>cat report.csv</code>')
    expect(html).toMatch(/<a [^>]+><span>封面<\/span><\/a>/)
    expect(html.match(/<button\b/g)).toHaveLength(1)
  })
})
