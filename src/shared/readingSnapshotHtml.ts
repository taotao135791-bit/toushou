import { validateReadingSnapshot, type ReadingSnapshot, type ReadingSnapshotAccount } from './readingSnapshot'

export interface ReadingSnapshotHtmlOptions {
  /** Anonymous by default. Explicit false exposes stored names, IDs and details. */
  anonymize?: boolean
  includeChart?: boolean
  language?: 'zh' | 'en'
  title?: string
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const period = (value: { start: string; end: string }) => value.start === value.end ? value.start : `${value.start} – ${value.end}`
const dateTime = (value: number | null) => value === null ? '—' : new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
const platform = (value: ReadingSnapshotAccount['platform']) => ({ facebook: 'Facebook', tiktok: 'TikTok', google: 'Google' })[value]
const status = (value: ReadingSnapshotAccount['status'], zh: boolean) => ({
  ok: zh ? '成功' : 'Read', failed: zh ? '失败' : 'Failed', unattempted: zh ? '未尝试' : 'Not attempted', unavailable: zh ? '不可用' : 'Unavailable'
})[value]
// Result labels can be custom, identifying text. Anonymous exports translate
// only exact known semantics; never forward unknown free text to the file.
const safeResultTypes = new Map<string, { zh: string; en: string }>([
  ['app_install', { zh: '应用安装', en: 'App installs' }],
  ['应用安装量', { zh: '应用安装', en: 'App installs' }],
  ['移动应用安装量', { zh: '移动应用安装', en: 'Mobile app installs' }],
  ['App installs', { zh: '应用安装', en: 'App installs' }],
  ['Mobile app installs', { zh: '移动应用安装', en: 'Mobile app installs' }],
  ['purchase', { zh: '购买', en: 'Purchases' }],
  ['Purchases', { zh: '购买', en: 'Purchases' }],
  ['应用内购买', { zh: '应用内购买', en: 'In-app purchases' }],
  ['In-app purchases', { zh: '应用内购买', en: 'In-app purchases' }],
  ['Website purchases', { zh: '网站购买', en: 'Website purchases' }]
])

function resultTypeLabel(account: ReadingSnapshotAccount, anonymous: boolean, zh: boolean): string {
  const value = account.resultType?.trim() ?? ''
  if (!anonymous && value) return value
  const known = safeResultTypes.get(value)
  return known ? (zh ? known.zh : known.en) : (zh ? '结果类型未知' : 'Result type unknown')
}

interface ChartGroup { platform: ReadingSnapshotAccount['platform']; currency: string | null; entries: Array<{ account: ReadingSnapshotAccount; index: number }> }

/** A single unknown-currency account always has a separate scale. */
export function readingSnapshotHtmlChartGroups(snapshot: ReadingSnapshot): ChartGroup[] {
  const groups = new Map<string, ChartGroup>()
  snapshot.accounts.forEach((account, index) => {
    if (account.status !== 'ok' || account.spend === null) return
    const key = `${account.platform}:${account.currency ?? `unknown-${index}`}`
    const group = groups.get(key) ?? { platform: account.platform, currency: account.currency, entries: [] }
    group.entries.push({ account, index })
    groups.set(key, group)
  })
  return [...groups.values()]
}

/** Entirely static and self-contained: no script, remote resources, or SVG. */
export function renderReadingSnapshotHtml(raw: unknown, options: ReadingSnapshotHtmlOptions = {}): string {
  const snapshot = validateReadingSnapshot(raw)
  if (!snapshot) throw new Error('invalid-snapshot')
  const anonymous = options.anonymize !== false
  const zh = options.language !== 'en'
  // Never interpolate user-controlled titles, labels, details or timezone into an anonymous export.
  const title = anonymous ? (zh ? '读数快照' : 'Reading snapshot') : (options.title?.trim() || (zh ? '读数快照' : 'Reading snapshot'))
  const label = (account: ReadingSnapshotAccount, index: number) => anonymous
    ? `${zh ? '账户' : 'Account'} ${index + 1}`
    : `${account.name || account.accountId || '—'}${account.name && account.accountId ? ` (${account.accountId})` : ''}`
  const headings = zh ? ['平台', '账户', '状态', '报告日期', '来源时间', '币种', '消耗', '上期消耗', '展示', '点击', '结果数'] : ['Platform', 'Account', 'Status', 'Report dates', 'Source time', 'Currency', 'Spend', 'Prior spend', 'Impressions', 'Clicks', 'Results']
  const rows = snapshot.accounts.map((account, index) => {
    const details = !anonymous && account.statusDetail ? `<br><small>${escapeHtml(account.statusDetail)}</small>` : ''
    const timezone = !anonymous && account.timezone ? ` · ${escapeHtml(account.timezone)}` : ''
    const prior = account.previousWindow ? `<br><small>${zh ? '上期' : 'Prior'} ${period(account.previousWindow)}</small>` : ''
    const metrics = [account.spend, account.previousSpend, account.impressions, account.clicks, account.conversions].map((value, index) => `<td class="num">${number(value)}${index === 4 ? `<br><small>${escapeHtml(resultTypeLabel(account, anonymous, zh))}</small>` : ''}</td>`).join('')
    return `<tr><td>${platform(account.platform)}</td><td>${escapeHtml(label(account, index))}</td><td>${status(account.status, zh)}${details}</td><td>${period(account.window)}${timezone}${prior}</td><td>${dateTime(account.sourceAt)}</td><td>${account.currency ?? (zh ? '未知' : 'Unknown')}</td>${metrics}</tr>`
  }).join('\n')
  const groups = options.includeChart ? readingSnapshotHtmlChartGroups(snapshot) : []
  const charts = options.includeChart ? `<section><h2>${zh ? '账户消耗（按平台和币种分别展示）' : 'Account spend (separate platform and currency groups)'}</h2>${groups.length ? groups.map(group => {
    const max = Math.max(...group.entries.map(({ account }) => account.spend!), 0)
    const bars = group.entries.map(({ account, index }) => {
      const width = max > 0 ? Math.min(100, account.spend! / max * 100) : 0
      return `<li><span>${escapeHtml(label(account, index))}</span><span class="track"><span class="bar" style="width:${width.toFixed(2)}%"></span></span><span class="num">${number(account.spend)}</span></li>`
    }).join('')
    return `<div class="group"><h3>${platform(group.platform)} · ${group.currency ?? (zh ? '币种未知（单账户）' : 'Currency unknown (one account)')}</h3><ul>${bars}</ul></div>`
  }).join('') : `<p>${zh ? '没有可绘制的成功读数。' : 'No successful readings to chart.'}</p>`}</section>` : ''
  const labelText = !anonymous ? ` · ${escapeHtml(snapshot.rangeLabel)}` : ''
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#172133;background:#f5f6f8;margin:0}main{max-width:1280px;margin:auto;padding:28px}h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}h3{font-size:14px;margin:0 0 6px}.sub,small{color:#59677a}.table-wrap{overflow-x:auto;background:#fff;border-radius:10px}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:9px 10px;border-bottom:1px solid #e2e7ed;vertical-align:top}th{background:#edf1f6;white-space:nowrap}.num{text-align:right;font-variant-numeric:tabular-nums}section{margin-top:22px}.group{background:#fff;border-radius:10px;padding:14px;margin-top:10px}.group ul{list-style:none;margin:0;padding:0}.group li{display:grid;grid-template-columns:minmax(95px,1fr) minmax(90px,3fr) auto;align-items:center;gap:10px;margin:5px 0}.track{height:12px;background:#e5eaf0;border-radius:6px}.bar{display:block;height:12px;background:#2770d6;border-radius:6px}footer{color:#59677a;margin-top:20px;font-size:12px}@media(max-width:560px){main{padding:14px}.group li{grid-template-columns:minmax(70px,1fr) minmax(65px,2fr) auto}}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p class="sub">${zh ? '保存的读数快照，不会自动刷新' : 'Saved reading snapshot; it does not refresh automatically'}${labelText} · ${period(snapshot.window)} · ${zh ? '保存于' : 'Saved'} ${dateTime(snapshot.capturedAt)}</p><div class="table-wrap"><table><caption>${zh ? '按账户的报告数据' : 'Account report data'}</caption><thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${charts}<footer>${anonymous ? (zh ? '账户名称与 ID 已脱敏；数值仍属于敏感数据，请谨慎分享。' : 'Account names and IDs are anonymized; metrics can still be sensitive.') : (zh ? '包含账户名称或 ID，请谨慎分享。' : 'Contains account names or IDs; share carefully.')}</footer></main></body></html>`
}
