import { parse, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5'
import postcss from 'postcss'
import { validateReadingSnapshot, type ReadingSnapshot } from './readingSnapshot'
import { renderReadingSnapshotHtml } from './readingSnapshotHtml'

export type HtmlBoardTemplate = 'editorial' | 'operations' | 'minimal'
export type HtmlBoardLanguage = 'zh' | 'en'
export interface HtmlBoardDocument {
  schemaVersion: 1
  id: string
  revision: number
  source: { boardId: string; widgetId: string; snapshotHash: string }
  snapshot: ReadingSnapshot
  includeChart: boolean
  /** Bounded trusted-report style; missing on older local documents. */
  theme?: HtmlBoardTemplate
  html: string
  css: string
  createdAt: number
  updatedAt: number
}
export interface HtmlBoardOpenInput { boardId: string; widgetId: string; template?: HtmlBoardTemplate; language?: HtmlBoardLanguage }
export interface HtmlBoardSaveInput { id: string; expectedRevision: number; html: string; css: string; theme?: HtmlBoardTemplate }
export interface HtmlBoardExportInput { id: string; expectedRevision: number; anonymize?: boolean; language?: HtmlBoardLanguage }
export type HtmlBoardError = 'invalid-input' | 'not-found' | 'invalid-snapshot' | 'invalid-document' | 'conflict' | 'store-unreadable' | 'limit' | 'cancelled' | 'write-failed'
export type HtmlBoardDocumentResult = { ok: true; document: HtmlBoardDocument } | { ok: false; error: HtmlBoardError }
export type HtmlBoardExportResult = { ok: true } | { ok: false; error: HtmlBoardError }
export const HTML_BOARD_MAX_HTML = 40_000
export const HTML_BOARD_MAX_CSS = 20_000

const templates: Record<HtmlBoardTemplate, { html: string; css: string }> = {
  editorial: {
    html: '<header class="hero"><p class="eyebrow">PERFORMANCE REVIEW</p><h1>投放读数周报</h1><p>在这里写本期重点与下一步。</p></header><div data-reading-slot></div><section class="notes"><h2>下一步</h2><p>记录要复核的问题与负责人。</p></section>',
    css: '.hero { background: #f3eee6; color: #283141; padding: 28px; border-radius: 16px; } .eyebrow { color: #a55d32; font-size: 12px; font-weight: 700; } .notes { background: #fff; padding: 20px; border-radius: 12px; }'
  },
  operations: {
    html: '<header class="hero"><p class="tag">ACCOUNT PATROL</p><h1>账户巡检看板</h1><p>请先核对失败、时间和币种。</p></header><div data-reading-slot></div><section class="notes"><h2>待处理</h2><ul><li>填写需要复核的账户。</li></ul></section>',
    css: '.hero { background: #102f44; color: #ffffff; padding: 24px; border-radius: 8px; } .tag { color: #9bd6dd; font-size: 12px; font-weight: 700; } .notes { background: #e8f3f4; color: #173d48; padding: 20px; }'
  },
  minimal: {
    html: '<header class="hero"><h1>读数快照</h1><p>填写简短说明。</p></header><div data-reading-slot></div><section class="notes"><p>补充说明。</p></section>',
    css: '.hero { color: #181818; padding: 18px; border-bottom: 2px solid #181818; } .notes { color: #444444; padding: 18px; }'
  }
}

/** Return a copy so editing one template never modifies another. */
export function htmlBoardTemplate(id: HtmlBoardTemplate, language: HtmlBoardLanguage = 'zh'): { html: string; css: string } {
  if (!Object.hasOwn(templates, id)) throw new Error('invalid-template')
  const template = templates[id]
  if (language !== 'en') return { ...template }
  const html: Record<HtmlBoardTemplate, string> = {
    editorial: '<header class="hero"><p class="eyebrow">PERFORMANCE REVIEW</p><h1>Weekly report</h1><p>Write this period’s priorities and next steps here.</p></header><div data-reading-slot></div><section class="notes"><h2>Next steps</h2><p>Record questions and owners.</p></section>',
    operations: '<header class="hero"><p class="tag">ACCOUNT PATROL</p><h1>Account inspection</h1><p>Check failures, dates, and currencies first.</p></header><div data-reading-slot></div><section class="notes"><h2>To review</h2><ul><li>List accounts requiring attention.</li></ul></section>',
    minimal: '<header class="hero"><h1>Reading snapshot</h1><p>Add a brief introduction.</p></header><div data-reading-slot></div><section class="notes"><p>Add notes.</p></section>'
  }
  return { html: html[id], css: template.css }
}

type Child = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element
const tags = new Set(['div', 'section', 'article', 'header', 'footer', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'br', 'hr'])

/** Parse HTML as a tree; reject unsafe nodes/attributes rather than guessing. */
export function parseHtmlBoardTemplate(html: string): { before: string; after: string } {
  if (typeof html !== 'string' || html.length > HTML_BOARD_MAX_HTML) throw new Error('invalid-html')
  let parseError = false
  const fragment = parseFragment(html, { onParseError: () => { parseError = true } })
  if (parseError) throw new Error('invalid-html')
  let count = 0, slot = -1, nodes = 0
  const visit = (node: Child, depth: number, top: boolean, index: number) => {
    if (++nodes > 2000 || depth > 32) throw new Error('html-limit')
    if (node.nodeName === '#text') return
    if (node.nodeName === '#comment') return
    if (!('tagName' in node)) throw new Error('unsupported-html')
    const element = node as Element
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !tags.has(element.tagName)) throw new Error('unsupported-html')
    const marker = element.attrs.find(attribute => attribute.name === 'data-reading-slot')
    if (marker) {
      count++
      if (!top || element.tagName !== 'div' || element.attrs.length !== 1 || marker.value !== '' || element.childNodes.some(child => child.nodeName !== '#text' || ('value' in child && child.value.trim()))) throw new Error('invalid-slot')
      slot = index
    } else {
      for (const attribute of element.attrs) {
        if (attribute.namespace || !['class', 'title', 'aria-label', 'colspan', 'rowspan'].includes(attribute.name)) throw new Error('unsupported-attribute')
        if (attribute.value.length > 200 || /[\x00-\x1f\x7f]/.test(attribute.value)) throw new Error('unsupported-attribute')
        if (attribute.name === 'class' && !/^[A-Za-z0-9_\- ]*$/.test(attribute.value)) throw new Error('unsupported-attribute')
        if ((attribute.name === 'colspan' || attribute.name === 'rowspan') && !/^[1-9][0-9]?$/.test(attribute.value)) throw new Error('unsupported-attribute')
      }
    }
    for (const child of element.childNodes) visit(child, depth + 1, false, index)
  }
  fragment.childNodes.forEach((node, index) => visit(node, 0, true, index))
  if (count !== 1 || slot < 0) throw new Error('invalid-slot')
  return { before: fragment.childNodes.slice(0, slot).map(node => serializeOuter(node)).join(''), after: fragment.childNodes.slice(slot + 1).map(node => serializeOuter(node)).join('') }
}

const cssProperties = new Set(['color', 'background', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space', 'display', 'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'border-color', 'border-width', 'border-style'])
const cssFunctions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'linear-gradient', 'repeat', 'minmax', 'calc', 'min', 'max', 'clamp'])

/** Parse CSS rules and reconstruct a restricted stylesheet scoped outside trusted data. */
export function scopedHtmlBoardCss(css: string): string {
  if (typeof css !== 'string' || css.length > HTML_BOARD_MAX_CSS || /[\\<>@\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(css)) throw new Error('invalid-css')
  let root: postcss.Root
  try { root = postcss.parse(css) } catch { throw new Error('invalid-css') }
  const output: string[] = []
  let total = 0
  for (const node of root.nodes) {
    if (++total > 500) throw new Error('css-limit')
    if (node.type === 'comment') continue
    if (node.type !== 'rule' || !node.nodes?.length) throw new Error('unsupported-css')
    const selectors = node.selector.split(',').map(value => value.trim())
    if (!selectors.length || selectors.some(value => !value || value.length > 200 || !/^[A-Za-z0-9_.*>\-\s]+$/.test(value))) throw new Error('unsupported-selector')
    const declarations: string[] = []
    for (const declaration of node.nodes) {
      if (++total > 500) throw new Error('css-limit')
      if (declaration.type !== 'decl' || declaration.important || !cssProperties.has(declaration.prop.toLowerCase())) throw new Error('unsupported-css')
      const value = declaration.value.trim()
      if (!value || value.length > 500 || !/^[A-Za-z0-9#.,%()\s+\-/]+$/.test(value) || /-\s*\d|\d[eE][+-]?\d/.test(value)) throw new Error('unsupported-css-value')
      for (const match of value.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*\(/g)) if (!cssFunctions.has(match[1].toLowerCase())) throw new Error('unsupported-css-function')
      for (const match of value.matchAll(/(?:^|[^#A-Za-z0-9])([0-9]+(?:\.[0-9]+)?)/g)) if (Number(match[1]) > 10_000) throw new Error('css-value-limit')
      declarations.push(`${declaration.prop.toLowerCase()}:${value}`)
    }
    const scope = ['#html-board-custom-before', '#html-board-custom-after'].flatMap(prefix => selectors.map(selector => `${prefix} ${selector}`)).join(',')
    output.push(`${scope}{${declarations.join(';')}}`)
  }
  return output.join('\n')
}

export function validateHtmlBoardDocument(raw: unknown): HtmlBoardDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['schemaVersion', 'id', 'revision', 'source', 'snapshot', 'includeChart', 'theme', 'html', 'css', 'createdAt', 'updatedAt'].includes(key))) return null
  const source = value.source as Record<string, unknown> | null
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['boardId', 'widgetId', 'snapshotHash'].includes(key)) || typeof source.boardId !== 'string' || !source.boardId || source.boardId.length > 100 || /[\x00-\x1f\x7f]/.test(source.boardId) || typeof source.widgetId !== 'string' || !source.widgetId || source.widgetId.length > 100 || /[\x00-\x1f\x7f]/.test(source.widgetId) || typeof source.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.snapshotHash) || !validateReadingSnapshot(value.snapshot) || typeof value.includeChart !== 'boolean' || (value.theme !== undefined && value.theme !== 'editorial' && value.theme !== 'operations' && value.theme !== 'minimal') || typeof value.html !== 'string' || typeof value.css !== 'string' || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || (value.createdAt as number) < 0 || (value.updatedAt as number) < (value.createdAt as number)) return null
  try { parseHtmlBoardTemplate(value.html); scopedHtmlBoardCss(value.css) } catch { return null }
  return value as unknown as HtmlBoardDocument
}

/** Isolate user-authored content around a trusted immutable report slot. */
export function renderHtmlBoard(raw: unknown, options: { anonymize?: boolean; language?: HtmlBoardLanguage } = {}): string {
  const document = validateHtmlBoardDocument(raw)
  if (!document) throw new Error('invalid-document')
  const template = parseHtmlBoardTemplate(document.html)
  const customCss = scopedHtmlBoardCss(document.css)
  const snapshotHtml = renderReadingSnapshotHtml(document.snapshot, { anonymize: options.anonymize !== false, includeChart: document.includeChart, language: options.language })
  const parsed = parse(snapshotHtml)
  const find = (nodes: Child[], tag: string): Element | undefined => {
    for (const node of nodes) {
      if ('tagName' in node && node.tagName === tag) return node as Element
      if ('childNodes' in node) { const found = find(node.childNodes, tag); if (found) return found }
    }
    return undefined
  }
  const headStyle = find(parsed.childNodes, 'style')
  const main = find(parsed.childNodes, 'main')
  if (!headStyle || !main) throw new Error('invalid-snapshot-template')
  const style = headStyle.childNodes.map(node => node.nodeName === '#text' && 'value' in node ? node.value : '').join('')
  const zh = options.language !== 'en'
  // Only these fixed styles can affect the report; authored CSS remains scoped
  // to the before/after content and cannot hide or replace source figures.
  const reportThemes: Record<HtmlBoardTemplate, string> = {
    editorial: 'main{font-family:Georgia,serif;color:#283141}main h1{color:#8a4d2f}main th{background:#f3eee6;color:#283141}main td{border-bottom-color:#e6ddd2}main .bar{background:#a55d32}',
    operations: 'main{font-family:system-ui,sans-serif;color:#14384a}main h1{color:#0d4d5a}main th{background:#dceef0;color:#14384a}main td{border-bottom-color:#c4dde0}main .bar{background:#197c86}',
    minimal: 'main{font-family:system-ui,sans-serif;color:#181818}main h1{color:#181818}main th{background:#efefef;color:#181818}main td{border-bottom-color:#d9d9d9}main .bar{background:#333333}'
  }
  const reportStyle = reportThemes[document.theme ?? 'editorial']
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${zh ? '自定义读数看板' : 'Custom reading board'}</title><style>${style}\n${reportStyle}\n${customCss}\n.html-board-note{max-width:1280px;margin:12px auto;padding:8px 28px;color:#59677a;font-size:12px}#html-board-custom-before,#html-board-custom-after{max-width:1280px;margin:0 auto;padding:0 28px}</style></head><body><p class="html-board-note">${zh ? '自定义 HTML/CSS（包括文本、属性及注释）由作者填写，不会自动脱敏或核验，请检查后分享。' : 'Custom HTML/CSS, including text, attributes and comments, is authored by the editor and is not anonymized or verified. Review before sharing.'}</p><div id="html-board-custom-before">${template.before}</div><main>${serialize(main)}</main><div id="html-board-custom-after">${template.after}</div></body></html>`
}
