import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
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
    expect(html.match(/<button\b/g)).toHaveLength(3)
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

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

function elements(node: HtmlNode, tag: string): HtmlElement[] {
  const match = 'tagName' in node && node.tagName === tag ? [node] : []
  return 'childNodes' in node ? match.concat(node.childNodes.flatMap(child => elements(child, tag))) : match
}

function visibleText(node: HtmlNode): string {
  if ('value' in node) return node.value
  return 'childNodes' in node ? node.childNodes.map(visibleText).join('') : ''
}

function attr(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find(attribute => attribute.name === name)?.value
}

function mentionsIn(node: HtmlNode): HtmlElement[] {
  return elements(node, 'a').filter(link => attr(link, 'class')?.split(' ').includes('chat-attachment-mention'))
}

function reply(content: string) {
  const html = renderToStaticMarkup(<Markdown content={content} replyAttachments />)
  const document = parseFragment(html)
  const footers = elements(document, 'ul').filter(list => ['附件', 'Attachments'].includes(attr(list, 'aria-label') ?? ''))
  return { html, document, footers }
}

describe('assistant reply attachment mentions and footer', () => {
  it('locates an HTML report and plain file names in a delivery folder named later in the reply', () => {
    const { document, footers } = reply([
      '请打开 `示例周报.html`，也可看 [周报](./示例周报.html)。',
      '',
      '文件都在 `/tmp/示例交付/`：HTML（图已内嵌）、`.md`（纯文本）、`fig1-3.png`（单独三张图）。',
      '',
      '其他附件：指标.csv。'
    ].join('\n'))
    const cards = elements(footers[0], 'li')
    expect(cards).toHaveLength(3)
    expect(visibleText(cards[0])).toContain('示例周报.html')
    expect(attr(elements(cards[1], 'button')[0], 'title')).toBe('/tmp/示例交付')
    expect(attr(elements(cards[2], 'button')[0], 'title')).toBe('/tmp/示例交付/指标.csv')
    const paragraphs = elements(document, 'p')
    expect(mentionsIn(paragraphs[0]).map(link => attr(link, 'href'))).toEqual(Array(2).fill('#' + attr(cards[0], 'id')))
    expect(attr(mentionsIn(paragraphs[0])[0], 'title')).toBe('/tmp/示例交付/示例周报.html')
    expect(elements(paragraphs[1], 'button').map(el => attr(el, 'title'))).toEqual(['/tmp/示例交付', '/tmp/示例交付'])
    expect(elements(paragraphs[1], 'button').map(visibleText)).toEqual(['/tmp/示例交付/', 'fig1-3.png'])
    expect(elements(paragraphs[1], 'code').map(visibleText)).toEqual(['.md'])
  })

  it('deduplicates range folder cards while preserving links whose actual target is a literal range filename', () => {
    const { document, footers } = reply('输出目录：`/tmp/sample-plots/`，图片有 `fig1–3.png` 和 fig4-6.png。另附[单个文件](fig8-9.png)。')
    const paragraph = elements(document, 'p')[0]
    expect(elements(paragraph, 'button').map(visibleText)).toEqual(['/tmp/sample-plots/', 'fig1–3.png', 'fig4-6.png'])
    expect(mentionsIn(paragraph).map(el => attr(el, 'title'))).toEqual(['/tmp/sample-plots/fig8-9.png'])
    expect(elements(footers[0], 'li').map(el => attr(elements(el, 'button')[0], 'title'))).toEqual(['/tmp/sample-plots', '/tmp/sample-plots/fig8-9.png'])
    const unknown = reply('输出为 `fig1-3.png` 和 `.md`。')
    expect(unknown.footers).toHaveLength(0)
    expect(elements(unknown.document, 'code').map(visibleText)).toEqual(['fig1-3.png', '.md'])
  })

  it('uses multiple locally named directories without guessing a destination for an earlier ambiguous name', () => {
    const { document, footers } = reply([
      '先看 `report.csv`。', '',
      '甲的输出目录：`/tmp/Example North`，明细见 `report.csv`。',
      '',
      '乙的输出目录：`/tmp/Example South`，明细见 [报告](report.csv)。'
    ].join('\n'))
    expect(elements(elements(document, 'p')[0], 'code').map(visibleText)).toEqual(['report.csv'])
    const cards = elements(footers[0], 'li')
    expect(cards.map(card => attr(elements(card, 'button')[0], 'title'))).toEqual(['/tmp/Example North/report.csv', '/tmp/Example South/report.csv'])
  })

  it('reuses a unique explicit file path for a basename and preserves an explicitly linked literal range filename', () => {
    const { document, footers } = reply('打开 `report.pdf`，完整路径是 `/tmp/sample/report.pdf`。\n\n[文件](./fig1-3.png)')
    expect(mentionsIn(elements(document, 'p')[0]).map(el => attr(el, 'title'))).toEqual(['/tmp/sample/report.pdf', '/tmp/sample/report.pdf'])
    expect(elements(footers[0], 'li')).toHaveLength(2)
  })

  it('keeps labels and punctuation in the sentence and puts the deduplicated card after the closing paragraph', () => {
    const { html, document, footers } = reply('请看[明细](report.pdf)，也可以打开 `report.pdf`。\n\n以上是结论。')
    const paragraphs = elements(document, 'p')
    expect(paragraphs.map(visibleText)).toEqual(['请看明细，也可以打开 report.pdf。', '以上是结论。'])
    const mentions = mentionsIn(paragraphs[0])
    expect(mentions.map(visibleText)).toEqual(['明细', 'report.pdf'])
    expect(mentions.every(link => elements(link, 'img').length + elements(link, 'svg').length === 1)).toBe(true)
    expect(footers).toHaveLength(1)
    const cards = elements(footers[0], 'li')
    expect(cards).toHaveLength(1)
    const cardId = attr(cards[0], 'id')
    expect(cardId).toBeTruthy()
    expect(mentions.map(link => attr(link, 'href'))).toEqual(['#' + cardId, '#' + cardId])
    expect(elements(footers[0], 'button')).toHaveLength(3)
    expect(html.indexOf('以上是结论。')).toBeLessThan(html.indexOf('<ul'))
  })

  it('keeps different files with the same basename separate and preserves their first-mention order', () => {
    const { document, footers } = reply('先看[旧日报](old/report.csv)，再看[新日报](new/report.csv)，最后重看[旧日报](old/report.csv)。')
    const mentions = mentionsIn(elements(document, 'p')[0])
    expect(mentions.map(visibleText)).toEqual(['旧日报', '新日报', '旧日报'])
    expect(footers).toHaveLength(1)
    const cards = elements(footers[0], 'li')
    expect(cards.map(card => attr(elements(card, 'button')[0], 'title'))).toEqual(['old/report.csv', 'new/report.csv'])
    const ids = cards.map(card => attr(card, 'id'))
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(mentions.map(link => attr(link, 'href'))).toEqual(['#' + ids[0], '#' + ids[1], '#' + ids[0]])
  })

  it('groups an encoded file URL and its local path into one card while keeping both mentions clickable', () => {
    const { document, footers } = reply('打开[报告](file:///tmp/Sales%20Q4.pdf)，路径为 `/tmp/Sales Q4.pdf`。')
    const paragraph = elements(document, 'p')[0]
    expect(mentionsIn(paragraph).map(visibleText)).toEqual(['报告', 'Sales Q4.pdf'])
    expect(footers).toHaveLength(1)
    expect(elements(footers[0], 'li')).toHaveLength(1)
    expect(visibleText(footers[0])).toContain('Sales Q4.pdf')
  })

  it('preserves list and table text, resolves reference links and uses an image icon for a local photo', () => {
    const { html, document, footers } = reply([
      '- 查看[原始明细][report]，然后核对。',
      '',
      '| 文件 | 状态 |', '| --- | --- |', '| ![截图](./assets/chart.png) | 已校验 |',
      '',
      '核对完毕。',
      '',
      '[report]: ./reports/detail.csv'
    ].join('\n'))
    const lists = elements(document, 'ul')
    expect(lists).toHaveLength(2)
    const row = elements(lists[0], 'li')[0]
    expect(visibleText(row)).toBe('查看原始明细，然后核对。')
    expect(mentionsIn(row).map(visibleText)).toEqual(['原始明细'])
    const cells = elements(document, 'td')
    expect(cells.map(visibleText)).toEqual(['截图', '已校验'])
    const photo = mentionsIn(cells[0])
    expect(photo).toHaveLength(1)
    expect(attr(photo[0], 'data-attachment-kind')).toBe('photo')
    expect(elements(photo[0], 'img').length + elements(photo[0], 'svg').length).toBe(1)
    expect(footers).toHaveLength(1)
    expect(elements(footers[0], 'li')).toHaveLength(2)
    expect(html.indexOf('核对完毕。')).toBeLessThan(html.lastIndexOf('<ul'))
  })

  it('keeps code examples, embedded web photos and linked thumbnails in the reply body', () => {
    const { document, footers } = reply([
      '```sh', '/tmp/example.csv', '```', '',
      '`cat report.csv`', '',
      '![照片](https://example.com/photo.jpg)', '',
      '[![封面](https://example.com/thumb.png)](https://example.com/docs)', '',
      '[unused]: ./unused.pdf'
    ].join('\n'))
    expect(footers).toHaveLength(0)
    expect(elements(document, 'code').map(visibleText)).toEqual(['/tmp/example.csv', 'cat report.csv'])
    const links = elements(document, 'a')
    expect(links.map(link => attr(link, 'href'))).toEqual(['https://example.com/photo.jpg', 'https://example.com/docs'])
    expect(links.map(link => attr(elements(link, 'img')[0], 'src'))).toEqual(['https://example.com/photo.jpg', 'https://example.com/thumb.png'])
  })

  it('keeps a remote thumbnail inside its file mention with only the linked file in the footer', () => {
    const { document, footers } = reply('[![缩略图](https://example.com/thumb.jpg)](./output.pdf)')
    const mentions = mentionsIn(elements(document, 'p')[0])
    expect(mentions).toHaveLength(1)
    expect(attr(mentions[0], 'title')).toBe('./output.pdf')
    expect(elements(mentions[0], 'a')).toEqual(mentions)
    expect(elements(mentions[0], 'button')).toHaveLength(0)
    expect(elements(mentions[0], 'img').map(img => attr(img, 'src'))).toEqual(['https://example.com/thumb.jpg'])
    expect(footers).toHaveLength(1)
    expect(elements(footers[0], 'li')).toHaveLength(1)
    expect(attr(elements(footers[0], 'button')[0], 'title')).toBe('./output.pdf')
  })
})
