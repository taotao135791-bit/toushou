import { defaultTreeAdapter, parse, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5'
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
export const HTML_BOARD_ALLOWED_TAGS = ['div', 'section', 'article', 'header', 'footer', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'br', 'hr'] as const
const tags: Set<string> = new Set(HTML_BOARD_ALLOWED_TAGS)

/** Parse HTML as a tree; reject unsafe nodes/attributes rather than guessing. */
export function parseHtmlBoardTemplate(html: string, accountCount?: number): { before: string; after: string; hasCharts: boolean } {
  if (typeof html !== 'string' || html.length > HTML_BOARD_MAX_HTML) throw new Error('invalid-html')
  let parseError = false
  const fragment = parseFragment(html, { onParseError: () => { parseError = true } })
  if (parseError) throw new Error('invalid-html')
  let count = 0, slot = -1, nodes = 0, charts = 0
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
      const chart = element.attrs.find(attribute => attribute.name === 'data-reading-chart')
      if (chart) {
        charts++
        if (charts > 2 || element.tagName !== 'div' || !['spend', 'spend-bar', 'spend-pie', 'spend-donut'].includes(chart.value) || element.childNodes.length !== 0 || element.attrs.some(attribute => !['data-reading-chart', 'data-reading-motion'].includes(attribute.name)) || element.attrs.some(attribute => attribute.name === 'data-reading-motion' && attribute.value !== 'animate')) throw new Error('invalid-chart')
      }
      if (!chart && element.attrs.some(attribute => attribute.name === 'data-reading-motion')) throw new Error('invalid-chart-motion')
      const binding = element.attrs.find(attribute => attribute.name === 'data-reading-value')
      if (binding) {
        const match = /^(?:([1-9][0-9]{0,3}))\.(spend|previousSpend|impressions|clicks|conversions|currency|status|account|accountId|accountName|windowStart|windowEnd)$/.exec(binding.value)
        if (element.tagName !== 'span' || element.childNodes.length !== 0 || !match || (accountCount !== undefined && Number(match[1]) > accountCount) || element.attrs.some(attribute => !['data-reading-value', 'class'].includes(attribute.name))) throw new Error('invalid-binding')
      }
      for (const attribute of element.attrs) {
        if (attribute.namespace || !['class', 'title', 'aria-label', 'colspan', 'rowspan', 'data-reading-value', 'data-reading-chart', 'data-reading-motion'].includes(attribute.name)) throw new Error('unsupported-attribute')
        if (attribute.value.length > 200 || /[\x00-\x1f\x7f]/.test(attribute.value)) throw new Error('unsupported-attribute')
        if (attribute.name === 'class' && !/^[A-Za-z0-9_\- ]*$/.test(attribute.value)) throw new Error('unsupported-attribute')
        if ((attribute.name === 'colspan' || attribute.name === 'rowspan') && !/^[1-9][0-9]?$/.test(attribute.value)) throw new Error('unsupported-attribute')
      }
    }
    for (const child of element.childNodes) visit(child, depth + 1, false, index)
  }
  fragment.childNodes.forEach((node, index) => visit(node, 0, true, index))
  if (count !== 1 || slot < 0) throw new Error('invalid-slot')
  return { before: fragment.childNodes.slice(0, slot).map(node => serializeOuter(node)).join(''), after: fragment.childNodes.slice(slot + 1).map(node => serializeOuter(node)).join(''), hasCharts: charts > 0 }
}

export interface HtmlBoardBasicFields { title: string; summary: string; nextSteps: string }
type BasicField = keyof HtmlBoardBasicFields
type BasicNodes = Record<BasicField, Element>

/** Only plainly editable, unambiguous built-in layout nodes qualify for basic mode. */
function basicNodes(fragment: DefaultTreeAdapterTypes.DocumentFragment): BasicNodes | null {
  const elements = (nodes: Child[]): Element[] => nodes.filter((node): node is Element => 'tagName' in node)
  const hasClass = (node: Element, name: string) => (node.attrs.find(attr => attr.name === 'class')?.value ?? '').split(/\s+/).includes(name)
  const heroes = elements(fragment.childNodes).filter(node => node.tagName === 'header' && hasClass(node, 'hero'))
  const notes = elements(fragment.childNodes).filter(node => node.tagName === 'section' && hasClass(node, 'notes'))
  if (heroes.length !== 1 || notes.length !== 1) return null
  const headerChildren = elements(heroes[0].childNodes)
  const titles = headerChildren.filter(node => node.tagName === 'h1')
  const summaries = headerChildren.filter(node => node.tagName === 'p' && !hasClass(node, 'eyebrow') && !hasClass(node, 'tag'))
  const noteChildren = elements(notes[0].childNodes)
  const candidates = noteChildren.flatMap(node => node.tagName === 'p' ? [node] : node.tagName === 'ul' || node.tagName === 'ol' ? elements(node.childNodes).filter(child => child.tagName === 'li') : [])
  if (titles.length !== 1 || summaries.length !== 1 || candidates.length !== 1) return null
  const nodes = { title: titles[0], summary: summaries[0], nextSteps: candidates[0] }
  if (Object.values(nodes).some(node => node.childNodes.some(child => child.nodeName !== '#text'))) return null
  return nodes
}

/** Return null for custom or complex layouts; never normalize them silently. */
export function readHtmlBoardBasicFields(html: string): HtmlBoardBasicFields | null {
  try {
    parseHtmlBoardTemplate(html)
    const nodes = basicNodes(parseFragment(html))
    if (!nodes) return null
    const text = (node: Element) => node.childNodes.map(child => child.nodeName === '#text' && 'value' in child ? child.value : '').join('')
    return { title: text(nodes.title), summary: text(nodes.summary), nextSteps: text(nodes.nextSteps) }
  } catch { return null }
}

/** Replace only one text node through the HTML AST; markup typed as text stays text. */
export function updateHtmlBoardBasicField(html: string, field: BasicField, value: string): string | null {
  if (!['title', 'summary', 'nextSteps'].includes(field) || typeof value !== 'string' || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null
  try {
    parseHtmlBoardTemplate(html)
    const fragment = parseFragment(html)
    const nodes = basicNodes(fragment)
    if (!nodes) return null
    const target = nodes[field]
    target.childNodes = []
    defaultTreeAdapter.insertText(target, value)
    const updated = fragment.childNodes.map(node => serializeOuter(node)).join('')
    parseHtmlBoardTemplate(updated)
    return updated
  } catch { return null }
}

export const HTML_BOARD_ALLOWED_CSS_PROPERTIES = ['color', 'background', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space', 'display', 'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'border-color', 'border-width', 'border-style'] as const
const cssProperties: Set<string> = new Set(HTML_BOARD_ALLOWED_CSS_PROPERTIES)
export const HTML_BOARD_ALLOWED_CSS_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'linear-gradient', 'repeat', 'minmax', 'calc', 'min', 'max', 'clamp'] as const
const cssFunctions: Set<string> = new Set(HTML_BOARD_ALLOWED_CSS_FUNCTIONS)

/** Parse CSS rules and reconstruct a restricted stylesheet scoped outside trusted data. */
export function scopedHtmlBoardCss(css: string, protectCharts = false): string {
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
      if (!value || value.length > 500 || !/^[A-Za-z0-9#.,%()\s+\-/]+$/.test(value) || (/-\s*\d/.test(value) || /(?:^|[^#A-Za-z0-9])(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d/.test(value))) throw new Error('unsupported-css-value')
      for (const match of value.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*\(/g)) if (!cssFunctions.has(match[1].toLowerCase())) throw new Error('unsupported-css-function')
      for (const match of value.matchAll(/(?:^|[^#A-Za-z0-9])([0-9]+(?:\.[0-9]+)?)/g)) if (Number(match[1]) > 10_000) throw new Error('css-value-limit')
      declarations.push(`${declaration.prop.toLowerCase()}:${value}`)
    }
    // Exclude chart boundaries, their descendants, and every ancestor that
    // contains one: otherwise a rule on an ancestor could hide the chart.
    // Browsers without :has fail closed by ignoring the whole authored rule.
    const guard = protectCharts ? ':not([data-trusted-chart-boundary]):not([data-trusted-chart-boundary] *):not(:has([data-trusted-chart-boundary]))' : ''
    const scope = ['#html-board-custom-before', '#html-board-custom-after'].flatMap(prefix => selectors.map(selector => `${prefix} ${selector}${guard}`)).join(',')
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
  try { parseHtmlBoardTemplate(value.html, (value.snapshot as ReadingSnapshot).accounts.length); scopedHtmlBoardCss(value.css) } catch { return null }
  return value as unknown as HtmlBoardDocument
}

type TrustedChartKind = 'spend' | 'spend-bar' | 'spend-pie' | 'spend-donut'
const escapeChart = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

/** Snapshot-backed chart; only comparable platform, currency, date and timezone share a scale. */
function renderTrustedSpendChart(snapshot: ReadingSnapshot, kind: TrustedChartKind, animate: boolean, anonymous: boolean, zh: boolean): string {
  const groups = new Map<string, Array<{ account: ReadingSnapshot['accounts'][number]; index: number }>>()
  const timezoneGroups = new Map<string, number>()
  snapshot.accounts.forEach((account, index) => {
    if (account.status !== 'ok' || account.spend === null) return
    // Unknown currency or timezone must never imply comparability with another account.
    if (account.timezone && !timezoneGroups.has(account.timezone)) timezoneGroups.set(account.timezone, timezoneGroups.size + 1)
    const key = JSON.stringify([account.platform, account.currency ?? `unknown-currency-${index}`, account.window.start, account.window.end, account.timezone || `unknown-timezone-${index}`])
    const entries = groups.get(key) ?? []
    entries.push({ account, index }); groups.set(key, entries)
  })
  const excluded = snapshot.accounts.length - [...groups.values()].reduce((sum, entries) => sum + entries.length, 0)
  const isBar = kind === 'spend' || kind === 'spend-bar'
  const labels = { facebook: 'Facebook', tiktok: 'TikTok', google: 'Google' }
  const name = (entry: { account: ReadingSnapshot['accounts'][number]; index: number }) => anonymous
    ? `${zh ? '账户' : 'Account'} ${entry.index + 1}`
    : `${entry.account.name || entry.account.accountId || '—'}${entry.account.name && entry.account.accountId ? ` (${entry.account.accountId})` : ''}`
  const amount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const groupHtml = [...groups.values()].map(entries => {
    const first = entries[0].account
    const currency = first.currency ?? (zh ? '币种未知（单账户）' : 'Currency unknown (one account)')
    const timezone = first.timezone ? (anonymous ? `${zh ? '时区组' : 'Timezone group'} ${timezoneGroups.get(first.timezone)}` : first.timezone) : (zh ? '时区未知（单账户）' : 'Timezone unknown (one account)')
    const heading = `${labels[first.platform]} · ${currency} · ${first.window.start} – ${first.window.end} · ${timezone}`
    const max = Math.max(0, ...entries.map(entry => entry.account.spend!))
    const scaledTotal = max > 0 ? entries.reduce((sum, entry) => sum + entry.account.spend! / max, 0) : 0
    const color = (index: number) => `hsl(${Math.round(index * 137.508) % 360},60%,45%)`
    let position = 0
    const stops = entries.map((entry, i) => {
      const start = position
      position += scaledTotal ? (entry.account.spend! / max) / scaledTotal * 100 : 0
      return `${color(i)} ${start.toFixed(5)}% ${position.toFixed(5)}%`
    })
    const pie = !isBar && scaledTotal ? `<div class="trusted-pie ${kind === 'spend-donut' ? 'trusted-donut' : ''}" role="img" aria-label="${zh ? '账户消耗占比，详见下方数据' : 'Account spend shares; see values below'}" style="background:${kind === 'spend-donut' ? 'radial-gradient(circle,#fff 0 49%,transparent 50%),' : ''}conic-gradient(${stops.join(',')})"></div>` : ''
    const items = entries.map((entry, i) => {
      const label = escapeChart(name(entry)), spend = amount(entry.account.spend!)
      const width = max > 0 ? Math.min(100, entry.account.spend! / max * 100) : 0
      if (isBar) return `<li><span>${label}</span><span class="track"><span class="bar" style="width:${width.toFixed(2)}%"></span></span><span class="num">${spend}</span></li>`
      const share = scaledTotal ? `${((entry.account.spend! / max) / scaledTotal * 100).toFixed(2)}%` : '—'
      return `<li><span><span class="trusted-swatch" style="background:${color(i)}"></span>${label}</span><span class="num">${spend} · ${share}</span></li>`
    }).join('')
    return `<div class="group"><h3>${escapeChart(heading)}</h3>${pie}${!isBar && !scaledTotal ? `<p>${zh ? '合计为零，无法计算占比。' : 'Total is zero; shares are unavailable.'}</p>` : ''}<ul${isBar ? '' : ' class="trusted-legend"'}>${items}</ul></div>`
  }).join('')
  const title = zh ? '账户消耗（按平台和币种分别展示）' : 'Account spend (separate platform and currency groups)'
  const detail = zh ? `按平台、币种、日期和时区分组；${excluded} 个失败、未读取或缺失消耗的账户未计入。未知币种或时区单独展示。` : `Grouped by platform, currency, dates and timezone; ${excluded} failed, unread or missing-spend accounts are excluded. Unknown currencies or timezones are shown separately.`
  return `<section class="trusted-chart"${animate ? ' data-chart-motion-active=""' : ''}><h2>${title}</h2><details><summary>${zh ? '数据说明' : 'Data notes'}</summary><p>${detail}</p></details>${groupHtml || `<p>${zh ? '没有可绘制的成功读数。' : 'No successful readings to chart.'}</p>`}</section>`
}
const trustedChartStyles = `.trusted-pie{width:160px;height:160px;border-radius:50%;margin:12px auto}.trusted-swatch{display:inline-block;width:10px;height:10px;margin-right:6px}.trusted-legend li{grid-template-columns:1fr auto}[data-chart-motion-active]{animation:reading-chart-intro .45s ease-out}@keyframes reading-chart-intro{from{opacity:.2}to{opacity:1}}@media(prefers-reduced-motion:reduce){[data-chart-motion-active]{animation:none}}`

/** Populate validated binding spans with plain text from the immutable snapshot. */
function fillReadingValues(html: string, snapshot: ReadingSnapshot, anonymous: boolean, zh: boolean): string {
  const fragment = parseFragment(html)
  const visit = (node: Child) => {
    if (!('tagName' in node)) return
    const chartMarker = node.attrs.find(attr => attr.name === 'data-reading-chart')
    if (chartMarker) {
      const animate = node.attrs.some(attr => attr.name === 'data-reading-motion' && attr.value === 'animate')
      const kind = chartMarker.value as TrustedChartKind
      node.attrs = [{ name: 'data-trusted-chart-boundary', value: '' }]
      const trustedChart = parseFragment(renderTrustedSpendChart(snapshot, kind, animate, anonymous, zh))
      for (const child of [...trustedChart.childNodes]) defaultTreeAdapter.appendChild(node, child)
      return
    }
    const binding = node.attrs.find(attr => attr.name === 'data-reading-value')
    if (binding) {
      const [indexText, field] = binding.value.split('.')
      const index = Number(indexText) - 1
      const account = snapshot.accounts[index]
      let value: string
      if (field === 'accountId') value = anonymous ? '—' : account.accountId || '—'
      else if (field === 'accountName') value = anonymous ? `${zh ? '账户' : 'Account'} ${index + 1}` : account.name || '—'
      else if (field === 'account') value = anonymous ? `${zh ? '账户' : 'Account'} ${index + 1}` : `${account.name || account.accountId || '—'}${account.name && account.accountId ? ` (${account.accountId})` : ''}`
      else if (field === 'currency') value = account.currency ?? (zh ? '未知' : 'Unknown')
      else if (field === 'status') value = ({ ok: zh ? '成功' : 'Read', failed: zh ? '失败' : 'Failed', unattempted: zh ? '未尝试' : 'Not attempted', unavailable: zh ? '不可用' : 'Unavailable' })[account.status]
      else if (field === 'windowStart' || field === 'windowEnd') value = field === 'windowStart' ? account.window.start : account.window.end
      else {
        const metric = account[field as 'spend' | 'previousSpend' | 'impressions' | 'clicks' | 'conversions']
        value = account.status !== 'ok' || metric === null ? '—' : metric.toLocaleString('en-US', { maximumFractionDigits: 2 })
      }
      node.attrs = node.attrs.filter(attr => attr.name !== 'data-reading-value')
      defaultTreeAdapter.insertText(node, value)
    }
    for (const child of node.childNodes) visit(child)
  }
  fragment.childNodes.forEach(visit)
  return fragment.childNodes.map(node => serializeOuter(node)).join('')
}

/** Isolate user-authored content around a trusted immutable report slot. */
export function renderHtmlBoard(raw: unknown, options: { anonymize?: boolean; language?: HtmlBoardLanguage } = {}): string {
  const document = validateHtmlBoardDocument(raw)
  if (!document) throw new Error('invalid-document')
  const template = parseHtmlBoardTemplate(document.html, document.snapshot.accounts.length)
  const customCss = scopedHtmlBoardCss(document.css, template.hasCharts)
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
  const zh = options.language !== 'en'
  if (document.includeChart) {
    const original = find(main.childNodes, 'section')
    if (!original) throw new Error('invalid-snapshot-chart')
    const replacement = parseFragment(renderTrustedSpendChart(document.snapshot, 'spend-bar', false, options.anonymize !== false, zh)).childNodes[0]
    defaultTreeAdapter.insertBefore(main, replacement, original)
    defaultTreeAdapter.detachNode(original)
  }
  const style = headStyle.childNodes.map(node => node.nodeName === '#text' && 'value' in node ? node.value : '').join('')
  // Only these fixed styles can affect the report; authored CSS remains scoped
  // to the before/after content and cannot hide or replace source figures.
  const reportThemes: Record<HtmlBoardTemplate, string> = {
    editorial: 'main{font-family:Georgia,serif;color:#283141}main h1{color:#8a4d2f}main th{background:#f3eee6;color:#283141}main td{border-bottom-color:#e6ddd2}main .bar{background:#a55d32}',
    operations: 'main{font-family:system-ui,sans-serif;color:#14384a}main h1{color:#0d4d5a}main th{background:#dceef0;color:#14384a}main td{border-bottom-color:#c4dde0}main .bar{background:#197c86}',
    minimal: 'main{font-family:system-ui,sans-serif;color:#181818}main h1{color:#181818}main th{background:#efefef;color:#181818}main td{border-bottom-color:#d9d9d9}main .bar{background:#333333}'
  }
  const reportStyle = reportThemes[document.theme ?? 'editorial']
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${zh ? '自定义读数看板' : 'Custom reading board'}</title><style>${style}\n${reportStyle}\n${customCss}\n${trustedChartStyles}\n.html-board-note{max-width:1280px;margin:12px auto;padding:8px 28px;color:#59677a;font-size:12px}#html-board-custom-before,#html-board-custom-after{max-width:1280px;margin:0 auto;padding:0 28px}</style></head><body><p class="html-board-note">${zh ? '自定义文字和 AI 结论未经系统核验，也不会自动脱敏；请核对后分享。' : 'Custom text and AI conclusions are not verified or automatically anonymized. Review before sharing.'}</p><div id="html-board-custom-before">${fillReadingValues(template.before, document.snapshot, options.anonymize !== false, zh)}</div><main>${serialize(main)}</main><div id="html-board-custom-after">${fillReadingValues(template.after, document.snapshot, options.anonymize !== false, zh)}</div></body></html>`
}
