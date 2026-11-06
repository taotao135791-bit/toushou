import type { BoardDataset, BoardWidget } from '@shared/types'
import { columnIndex, DATASET_OPS, type DatasetOp } from '@shared/datasets'
import { deriveBoardAnalysis } from '@shared/boardAnalysis'
import { metricCurrencySafety, safeMetricGroups, safeMetricValue, uniformCurrency } from '../../lib/boardMetricSafety'
import { useAppStore } from '../../store'

/** Uses the same resolved rows as the metric cards; it never stores old prose. */
export function DatasetAnalysisBody({ widget, dataset, loading = false }: { widget: BoardWidget; dataset: BoardDataset; loading?: boolean }) {
  const zh = useAppStore(state => state.language) === 'zh'
  const metric = typeof widget.config.metric === 'string' ? widget.config.metric : ''
  const dimension = typeof widget.config.dimension === 'string' ? widget.config.dimension : ''
  const op = typeof widget.config.op === 'string' && (DATASET_OPS as readonly string[]).includes(widget.config.op) ? widget.config.op as DatasetOp : 'sum'
  const safety = metricCurrencySafety(dataset, metric)
  const metricIndex = columnIndex(dataset, metric), dimIndex = dimension ? columnIndex(dataset, dimension) : -1
  const value = safety === 'mixed' || safety === 'unknown' ? null : safeMetricValue(dataset, dataset.rows, metricIndex, op)
  const other = zh ? '其他' : 'Other'
  const grouped = value !== null && dimIndex >= 0 ? safeMetricGroups(dataset, dimIndex, metricIndex, op, other) : null
  const facts = deriveBoardAnalysis({ value, temporal: dimIndex >= 0 && dataset.columns[dimIndex]?.type === 'date',
    groups: grouped?.labels.flatMap((label, i) => label === other ? [] : [{ label, value: grouped.points[i] }]) })
  const currency = safety === 'safe' ? uniformCurrency(dataset) : null
  const number = (n: number) => `${n.toLocaleString(zh ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`
  if (loading || dataset.appsflyer?.status === 'failed' || dataset.appsflyer?.status === 'unbound' || !facts.length) return <div role="status" className="flex h-full items-center justify-center text-[12px] text-cream-faint">{loading ? (zh ? '更新中…' : 'Updating…') : dataset.appsflyer?.status === 'failed' || dataset.appsflyer?.status === 'unbound' ? (zh ? '分析待更新' : 'Analysis pending update') : (zh ? '暂无可分析的数据' : 'No data to analyze')}</div>
  return <ol className="flex h-full flex-col justify-center gap-3 text-[12.5px] leading-5 text-cream-dim" aria-label={zh ? '当前数据重点' : 'Current data highlights'}>
    {facts.map((fact, index) => <li key={fact.kind} className="flex min-w-0 gap-2.5">
      <span className="shrink-0 tabular-nums text-cream-faint">{String(index + 1).padStart(2, '0')}</span>
      <span className="min-w-0 break-words">{fact.kind === 'period'
        ? <>{zh ? `区间${metric}` : `Period ${metric}`} <strong className="font-medium tabular-nums text-cream">{number(fact.value)}</strong></>
        : fact.kind === 'leader'
          ? <>{fact.label} {zh ? `${metric}最高` : `has the highest ${metric}`} <strong className="font-medium tabular-nums text-cream">{number(fact.value)}</strong></>
          : <>{fact.from} → {fact.to}，{metric} {number(fact.fromValue)} → {number(fact.toValue)}{fact.percent !== null ? `（${fact.percent > 0 ? '+' : ''}${fact.percent.toFixed(1)}%）` : ''}</>}
      </span>
    </li>)}
  </ol>
}
