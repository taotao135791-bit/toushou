import type { BoardWidget } from './types'
import type { ReadingSnapshot } from './readingSnapshot'

export interface ReadingModuleSpec {
  kind: 'metric' | 'spend-chart' | 'coverage' | 'note'
  metric?: 'spend' | 'impressions' | 'clicks' | 'conversions'
  /** Zero-based index into this module's immutable snapshot. */
  accountIndex?: number
  chart?: 'bar' | 'pie' | 'donut'
  text?: string
}

export function validateReadingModuleSpec(raw: unknown, snapshot?: ReadingSnapshot): ReadingModuleSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (Object.keys(v).some(key => !['kind', 'metric', 'accountIndex', 'chart', 'text'].includes(key))) return null
  if (v.kind === 'metric') {
    if (Object.keys(v).some(key => !['kind', 'metric', 'accountIndex'].includes(key)) || typeof v.metric !== 'string' || !['spend', 'impressions', 'clicks', 'conversions'].includes(v.metric) || !Number.isSafeInteger(v.accountIndex) || (v.accountIndex as number) < 0 || (v.accountIndex as number) >= (snapshot?.accounts.length ?? 1000)) return null
  } else if (v.kind === 'spend-chart') {
    if (Object.keys(v).some(key => !['kind', 'chart'].includes(key)) || typeof v.chart !== 'string' || !['bar', 'pie', 'donut'].includes(v.chart)) return null
  } else if (v.kind === 'coverage') {
    if (Object.keys(v).some(key => key !== 'kind')) return null
  } else if (v.kind === 'note') {
    if (Object.keys(v).some(key => !['kind', 'text'].includes(key)) || typeof v.text !== 'string' || v.text.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v.text)) return null
  } else return null
  return structuredClone(v) as unknown as ReadingModuleSpec
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Safe HTML bindings: all numeric values are filled from the immutable source. */
export function readingModuleTemplate(spec: ReadingModuleSpec, snapshot: ReadingSnapshot, language: 'zh' | 'en' = 'zh'): { html: string; css: string } {
  if (!validateReadingModuleSpec(spec, snapshot)) throw new Error('invalid-module')
  const zh = language === 'zh'
  const labels = zh ? { spend: '消耗', impressions: '展示', clicks: '点击', conversions: '转化' } : { spend: 'Spend', impressions: 'Impressions', clicks: 'Clicks', conversions: 'Conversions' }
  let body: string
  if (spec.kind === 'metric') {
    const n = spec.accountIndex! + 1
    body = `<article class="metric"><p class="label">${labels[spec.metric!]}</p><p class="value"><span data-reading-value="${n}.${spec.metric}"></span>${spec.metric === 'spend' ? ` <small><span data-reading-value="${n}.currency"></span></small>` : ''}</p><p class="account"><span data-reading-value="${n}.accountName"></span></p><p class="period"><span data-reading-value="${n}.windowStart"></span> — <span data-reading-value="${n}.windowEnd"></span></p>${spec.metric === 'conversions' ? `<p><span data-reading-value="${n}.resultType"></span></p>` : ''}</article>`
  } else if (spec.kind === 'spend-chart') {
    body = `<div data-reading-chart="spend-${spec.chart}" data-reading-motion="animate"></div>`
  } else if (spec.kind === 'coverage') {
    const ok = snapshot.accounts.filter(account => account.status === 'ok').length
    body = `<article class="coverage"><h2>${zh ? '读数覆盖' : 'Reading coverage'}</h2><p class="value">${ok} / ${snapshot.accounts.length}</p><p>${zh ? '账户读取成功，其余读数不作零处理。' : 'Accounts read successfully; other readings are not treated as zero.'}</p><p>${zh ? '不同口径分组显示，不混算消耗。' : 'Platforms, currencies, dates and timezones are shown separately.'}</p></article>`
  } else {
    body = `<article class="notes"><h2>${zh ? '复核说明' : 'Review notes'}</h2><p>${escape(spec.text!)}</p></article>`
  }
  return { html: `${body}<div data-reading-slot></div>`, css: '.metric { padding: 16px; color: #202020; } .label { font-size: 14px; color: #555555; margin: 0; } .value { font-size: 34px; font-weight: 700; margin: 10px 0; line-height: 1.15; } .value small { font-size: 14px; } .account { font-size: 13px; margin: 8px 0; } .period { font-size: 11px; color: #555555; margin: 6px 0; } .coverage { padding: 16px; } .notes { padding: 16px; }' }
}

/** Independent widgets; the source snapshot remains a separate full-width module. */
export function createReadingModuleWidgets(snapshot: ReadingSnapshot, includeChart: boolean, language: 'zh' | 'en' = 'zh'): BoardWidget[] {
  const zh = language === 'zh'
  const specs: Array<{ title: string; module: ReadingModuleSpec; w: number; h: number }> = []
  const successes = snapshot.accounts.map((account, index) => ({ account, index })).filter(row => row.account.status === 'ok')
  if (successes.length === 1) {
    const accountIndex = successes[0].index
    for (const [metric, title] of [['spend', zh ? '消耗' : 'Spend'], ['impressions', zh ? '展示' : 'Impressions'], ['clicks', zh ? '点击' : 'Clicks']] as const) specs.push({ title, module: { kind: 'metric', metric, accountIndex }, w: 3, h: 5 })
    specs.push({ title: zh ? '读数覆盖' : 'Coverage', module: { kind: 'coverage' }, w: 3, h: 5 })
  } else specs.push({ title: zh ? '读数覆盖' : 'Coverage', module: { kind: 'coverage' }, w: 12, h: 4 })
  if (includeChart) {
    specs.push({ title: zh ? '账户消耗' : 'Account spend', module: { kind: 'spend-chart', chart: 'bar' }, w: 6, h: 8 })
    specs.push({ title: zh ? '消耗占比' : 'Spend share', module: { kind: 'spend-chart', chart: 'donut' }, w: 6, h: 8 })
  }
  specs.push({ title: zh ? '复核说明' : 'Review notes', module: { kind: 'note', text: zh ? '这是固定日期的读数快照。点击 AI 编辑可用自然语言定制本模块；失败与未读取账户不视为零，图表不代表实时刷新。' : 'This is a fixed-date snapshot. Use AI editing to customize this module. Failed and unread accounts are not zero; animation does not imply live data.' }, w: 12, h: 4 })
  let x = 0, y = 0, rowHeight = 0
  return specs.map(({ title, module, w, h }) => {
    if (x + w > 12) { x = 0; y += rowHeight; rowHeight = 0 }
    const widget: BoardWidget = { id: crypto.randomUUID(), type: 'reading-module', title, layout: { x, y, w, h }, config: { snapshot: structuredClone(snapshot), module } }
    x += w; rowHeight = Math.max(rowHeight, h)
    return widget
  })
}
