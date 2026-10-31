import { aggregate, columnIndex, GROUP_TOP_N, type DatasetOp } from '@shared/datasets'
import type { BoardDataset } from '@shared/types'

type Row = BoardDataset['rows'][number]
export type CurrencySafety = 'not-money' | 'safe' | 'unknown' | 'mixed'
const MONEY = /消耗|花费|费用|成本|金额|收入|转化价值|spend|cost|revenue|amount|conversion value|cpc|cpa|cpm|cpi/i
const norm = (value: string) => value.trim().toLowerCase()
const ratioKind = (name: string): 'ctr' | 'cpc' | 'cpa' | 'cpm' | null => {
  const n = norm(name)
  if (['点击率', 'ctr', 'click-through rate', 'click through rate'].includes(n)) return 'ctr'
  if (['平均点击成本', '每次点击费用', '点击成本', 'cpc', 'cost per click'].includes(n)) return 'cpc'
  if (['转化成本', '每次转化费用', 'cpa', 'cost per conversion'].includes(n)) return 'cpa'
  if (['千次展示费用', '千次展示成本', 'cpm', 'cost per mille'].includes(n)) return 'cpm'
  return null
}
export function metricCurrencySafety(dataset: BoardDataset, metric: string): CurrencySafety {
  if (!MONEY.test(metric)) return 'not-money'
  const idx = dataset.columns.findIndex(c => ['币种', 'currency', 'currency code'].includes(norm(c.name)))
  if (idx < 0 || dataset.rows.length === 0) return 'unknown'
  const codes = dataset.rows.map(row => typeof row[idx] === 'string' ? String(row[idx]).trim().toUpperCase() : '')
  if (codes.some(code => !/^[A-Z]{3}$/.test(code))) return 'unknown'
  return new Set(codes).size === 1 ? 'safe' : 'mixed'
}
export function uniformCurrency(dataset: BoardDataset): string | null {
  const index = dataset.columns.findIndex(c => ['币种', 'currency', 'currency code'].includes(norm(c.name)))
  if (index < 0 || !dataset.rows.length) return null
  const values = new Set(dataset.rows.map(row => typeof row[index] === 'string' ? String(row[index]).trim().toUpperCase() : ''))
  if (values.size !== 1) return null
  const value = [...values][0]
  return /^[A-Z]{3}$/.test(value) ? value : null
}
const indexOfAny = (dataset: BoardDataset, names: string[]): number => dataset.columns.findIndex(c => names.includes(norm(c.name)))
/** Ratios aggregate from totals, never from the arithmetic mean of row rates. */
export function safeMetricValue(dataset: BoardDataset, rows: Row[], metricIndex: number, op: DatasetOp): number | null {
  if (!rows.length || metricIndex < 0) return null
  const metric = dataset.columns[metricIndex]?.name ?? ''
  const ratio = ratioKind(metric)
  if (ratio && (op === 'avg' || op === 'sum')) {
    const num = indexOfAny(dataset, ratio === 'ctr' ? ['点击', '点击次数', 'clicks'] : ['消耗', '花费', '费用', 'spend', 'cost'])
    const den = indexOfAny(dataset, ratio === 'ctr' || ratio === 'cpm' ? ['展示', '展示次数', 'impressions'] : ratio === 'cpc' ? ['点击', '点击次数', 'clicks'] : ['转化', '转化次数', 'conversions'])
    if (num < 0 || den < 0 || rows.some(row => typeof row[num] !== 'number' || !Number.isFinite(row[num]) || typeof row[den] !== 'number' || !Number.isFinite(row[den]))) return null
    const numerator = rows.reduce((sum, row) => sum + (row[num] as number), 0)
    const denominator = rows.reduce((sum, row) => sum + (row[den] as number), 0)
    return denominator > 0 ? (numerator / denominator) * (ratio === 'ctr' ? 100 : ratio === 'cpm' ? 1000 : 1) : null
  }
  if (op !== 'count' && rows.some(row => typeof row[metricIndex] !== 'number' || !Number.isFinite(row[metricIndex]))) return null
  return aggregate(rows.map(row => row[metricIndex] ?? ''), op)
}
/** Date and categorical groups, including weighted Other, remain bounded. */
export function safeMetricGroups(dataset: BoardDataset, dimIndex: number, metricIndex: number, op: DatasetOp, otherLabel: string): {labels:string[];points:number[]} | null {
  const groups = new Map<string, Row[]>()
  const labelsByKey = new Map<string, string>()
  const campaignDimension = dataset.name === 'TikTok 报表' && dataset.columns[dimIndex]?.name === '活动名称'
  const advertiserIndex = columnIndex(dataset, '广告主ID'), campaignIndex = columnIndex(dataset, '活动ID'), accountNameIndex = columnIndex(dataset, '广告主')
  if (campaignDimension && (advertiserIndex < 0 || campaignIndex < 0)) return null
  for (const row of dataset.rows) {
    const label = row[dimIndex] === '' || row[dimIndex] === undefined ? '(empty)' : String(row[dimIndex])
    const advertiser = campaignDimension ? String(row[advertiserIndex] ?? '').trim() : ''
    const campaign = campaignDimension ? String(row[campaignIndex] ?? '').trim() : ''
    if (campaignDimension && (!advertiser || !campaign)) return null
    const key = campaignDimension ? `${advertiser}\0${campaign}` : label
    if (!labelsByKey.has(key)) labelsByKey.set(key, campaignDimension ? `${label} · ${accountNameIndex >= 0 ? String(row[accountNameIndex] ?? '') : ''} (${advertiser} / ${campaign})` : label)
    const items = groups.get(key) ?? []
    items.push(row); groups.set(key, items)
  }
  const entries = [...groups].map(([key, rows]) => ({ key, rows, value: safeMetricValue(dataset, rows, metricIndex, op) }))
  if (entries.some(entry => entry.value === null)) return null
  if (dataset.columns[dimIndex]?.type === 'date') entries.sort((a,b) => a.key.localeCompare(b.key))
  else entries.sort((a,b) => (b.value as number) - (a.value as number))
  const chosen = entries.length > GROUP_TOP_N && dataset.columns[dimIndex]?.type === 'date'
    ? new Set([...entries].sort((a,b) => (b.value as number)-(a.value as number)).slice(0,GROUP_TOP_N).map(e=>e.key))
    : new Set(entries.slice(0,GROUP_TOP_N).map(e=>e.key))
  const keep = entries.filter(e=>chosen.has(e.key)), rest = entries.filter(e=>!chosen.has(e.key))
  const labels = keep.map(e=>labelsByKey.get(e.key) ?? e.key), points = keep.map(e=>e.value as number)
  if (rest.length) { const value = safeMetricValue(dataset, rest.flatMap(e=>e.rows), metricIndex, op); if (value === null) return null; labels.push(otherLabel); points.push(value) }
  return {labels,points}
}
export function hasAmbiguousAdvertiserFilter(dataset: BoardDataset, filterColumn: string, names: string[]): boolean {
  if (filterColumn !== '广告主' || dataset.name !== 'TikTok 报表') return false
  const nameIndex = columnIndex(dataset, '广告主'), idIndex = columnIndex(dataset, '广告主ID')
  if (nameIndex < 0 || idIndex < 0) return true
  return names.some(name => {
    const matches = dataset.rows.filter(row => String(row[nameIndex]) === name)
    const ids = new Set(matches.map(row => String(row[idIndex] ?? '').trim()))
    return ids.has('') || ids.size > 1
  })
}
