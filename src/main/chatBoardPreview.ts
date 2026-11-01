import { parse, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5'
import postcss from 'postcss'
import { HTML_BOARD_ALLOWED_TAGS, scopedHtmlBoardCss, renderHtmlBoard } from '../shared/htmlBoard'
import { renderReadingSnapshotHtml } from '../shared/readingSnapshotHtml'
import { isValidWidgetFilePath } from '../shared/boards'
import type { ChatBoardPreviewResult } from '../shared/chatBoardPreview'
import type { KanbanBoard } from '../shared/types'
import { listBoards } from './boards'
import { findHtmlBoardForReading } from './htmlBoards'
import { readWorkspaceDataset } from './boardsBridge'

const MAX_HTML_BYTES = 256 * 1024
const ALLOWED = new Set<string>([...HTML_BOARD_ALLOWED_TAGS, 'main'])
type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

/** Reconstruct a passive document; the original file never becomes srcdoc. */
export function staticFilePreview(input: string): string | null {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_HTML_BYTES) return null
  const document = parse(input)
  let count = 0
  let inlineCount = 0
  const css: string[] = []
  const safeCss = (raw: string): void => {
    if (raw.length > 20_000) return
    try {
      const root = postcss.parse(raw)
      for (const rule of root.nodes) {
        if (rule.type !== 'rule') continue
        const accepted: string[] = []
        for (const declaration of rule.nodes ?? []) {
          if (declaration.type !== 'decl') continue
          try { scopedHtmlBoardCss(`${rule.selector}{${declaration.toString()}}`); accepted.push(declaration.toString()) } catch { /* discard unsupported syntax */ }
        }
        if (accepted.length) {
          try { css.push(scopedHtmlBoardCss(`${rule.selector}{${accepted.join(';')}}`)) } catch { /* discard rule */ }
        }
      }
    } catch { /* malformed style is omitted */ }
  }
  const clean = (node: Node, depth: number): string => {
    if (++count > 3000 || depth > 32) throw new Error('limit')
    if (node.nodeName === '#text') return serializeOuter(node)
    if (!('tagName' in node)) return ''
    const element = node as Element
    if (element.tagName === 'style') { safeCss(element.childNodes.filter(child => child.nodeName === '#text').map(child => 'value' in child ? child.value : '').join('')); return '' }
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !ALLOWED.has(element.tagName)) return ''
    const inline = element.attrs.find(attr => attr.name === 'style' && !attr.namespace)
    if (inline && inline.value.length <= 2000) {
      const className = `preview-inline-${++inlineCount}`
      safeCss(`.${className}{${inline.value}}`)
      const currentClass = element.attrs.find(attr => attr.name === 'class' && !attr.namespace && /^[A-Za-z0-9_ -]{0,160}$/.test(attr.value))
      if (currentClass) currentClass.value += ` ${className}`
      else element.attrs.push({ name: 'class', value: className })
    }
    element.attrs = element.attrs.filter(attr => !attr.namespace && (
      (attr.name === 'class' && /^[A-Za-z0-9_ -]{0,200}$/.test(attr.value)) ||
      (['title', 'aria-label'].includes(attr.name) && attr.value.length <= 200 && !/[\x00-\x1f\x7f]/.test(attr.value)) ||
      (['colspan', 'rowspan'].includes(attr.name) && /^[1-9][0-9]?$/.test(attr.value))
    ))
    const children = element.childNodes.map(child => clean(child, depth + 1)).join('')
    const empty = { ...element, childNodes: [] } as Element
    const outer = serializeOuter(empty)
    if (['br', 'hr'].includes(element.tagName)) return outer
    const closing = `</${element.tagName}>`
    return outer.endsWith(closing) ? outer.slice(0, -closing.length) + children + closing : ''
  }
  try {
    const html = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html') as Element | undefined
    const head = html?.childNodes.find(node => 'tagName' in node && node.tagName === 'head') as Element | undefined
    const body = html?.childNodes.find(node => 'tagName' in node && node.tagName === 'body') as Element | undefined
    head?.childNodes.forEach(node => clean(node, 0))
    const content = body?.childNodes.map(node => clean(node, 0)).join('') ?? ''
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;margin:16px}#html-board-custom-before{overflow-wrap:anywhere}${css.join('\n')}</style></head><body><div id="html-board-custom-before">${content}</div></body></html>`
  } catch { return null }
}

interface Dependencies {
  access: (sessionId: string) => { cwd: string } | null
  authorized: (cwd: string) => boolean
  boards?: () => KanbanBoard[]
  find?: typeof findHtmlBoardForReading
  readFile?: typeof readWorkspaceDataset
}

export function getChatBoardPreview(raw: unknown, deps: Dependencies): ChatBoardPreviewResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid-input' }
  const request = raw as Record<string, unknown>
  if (Object.keys(request).some(k => !['sessionId', 'boardId', 'widgetId'].includes(k)) || !['sessionId', 'boardId', 'widgetId'].every(k => typeof request[k] === 'string' && (request[k] as string).length > 0 && (request[k] as string).length <= 100 && !/[\x00-\x1f\x7f]/.test(request[k] as string))) return { ok: false, error: 'invalid-input' }
  const access = deps.access(request.sessionId as string)
  if (!access || !deps.authorized(access.cwd)) return { ok: false, error: 'unauthorized' }
  try {
    const board = (deps.boards ?? listBoards)().find(item => item.id === request.boardId)
    const widget = board?.widgets.find(item => item.id === request.widgetId)
    if (!board || !widget) return { ok: false, error: 'not-found' }
    if (widget.type === 'reading-snapshot' || widget.type === 'reading-module') {
      const found = (deps.find ?? findHtmlBoardForReading)({ boardId: board.id, widgetId: widget.id })
      let html: string
      if (found.ok) html = renderHtmlBoard(found.document, { anonymize: false })
      else if (found.error === 'not-found' && widget.type === 'reading-snapshot') html = renderReadingSnapshotHtml(widget.config.snapshot, { anonymize: false, includeChart: widget.config.includeChart === true })
      else return { ok: false, error: 'unavailable' }
      return { ok: true, html, source: widget.type === 'reading-module' ? 'module' : 'snapshot', boardName: board.name, widgetTitle: widget.title }
    }
    if (widget.type !== 'file' || typeof widget.config.filePath !== 'string' || !isValidWidgetFilePath(widget.config.filePath) || !widget.config.filePath.toLowerCase().endsWith('.html')) return { ok: false, error: 'unsupported' }
    const file = (deps.readFile ?? readWorkspaceDataset)(widget.config.filePath, access.cwd)
    if (!file || file.bytes.length > MAX_HTML_BYTES) return { ok: false, error: 'unavailable' }
    const html = staticFilePreview(file.bytes.toString('utf8'))
    return html ? { ok: true, html, source: 'file', boardName: board.name, widgetTitle: widget.title } : { ok: false, error: 'unavailable' }
  } catch { return { ok: false, error: 'unavailable' } }
}
