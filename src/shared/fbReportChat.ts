import { FbReportIssue, FbReportSummary } from './fbReportCsv'

/**
 * Builds the agent prompt for analyzing a verified FB report reading.
 * The data is already verified against Facebook's own totals row.
 */
export function buildFbReportAnalysisPrompt(
  fileName: string,
  summary: FbReportSummary,
  warnings: FbReportIssue[]
): string {
  const metricCols = summary.metrics ?? []
  const money = (value: number | null): string =>
    value === null ? '—' : value.toFixed(2)
  const count = (value: number | null): string =>
    value === null ? '—' : String(Math.round(value))
  const fmt = (value: number | null, kind: string): string =>
    kind === 'money' ? money(value) : count(value)
  const headerCols = metricCols.map((col) => col.header)
  const lines: string[] = []
  lines.push('请分析下面这份 Facebook 广告报表读数（已通过严格校验：逐行合计与 Facebook 自己的汇总行一致）。')
  lines.push('')
  lines.push('数据来源：' + fileName)
  lines.push('窗口：' + (summary.windowStart ?? '?') + ' 至 ' + (summary.windowEnd ?? '?') + '（共 ' + summary.days.length + ' 天）')
  if (summary.currency) lines.push('币种：' + summary.currency)
  if (summary.attribution) lines.push('归因口径：' + summary.attribution)
  lines.push('')
  lines.push('指标列：' + (headerCols.join('、') || '（无）'))
  lines.push('')
  lines.push('分账户数据：')
  for (const account of summary.accounts) {
    const cells = metricCols.map((col) => {
      const value = account.metrics?.[col.header] ?? null
      return col.header + '=' + fmt(value, col.kind)
    })
    lines.push('- ' + account.account + '：' + cells.join('，'))
  }
  lines.push('')
  lines.push('Facebook 汇总行（FB 官方口径）：')
  const totalCells = metricCols.map((col) => {
    const value = summary.totalsByHeader?.[col.header] ?? null
    return col.header + '=' + fmt(value, col.kind)
  })
  lines.push('- ' + (totalCells.join('，') || '（无）'))
  if (warnings.length > 0) {
    lines.push('')
    lines.push('数据警告（展示量类指标与 FB 汇总存在 FB 自身导出误差，显示以 FB 汇总为准）：')
    for (const warning of warnings) {
      lines.push('- ' + (warning.column ?? '') + '：明细加总 ' + count(warning.actual ?? null) + '，FB 汇总 ' + count(warning.expected ?? null))
    }
  }
  lines.push('')
  lines.push('请基于以上数据分析：1) 各账户表现对比与主要差异；2) 值得注意的异常或趋势；3) 下一步投放建议。分析时引用具体数字，不要编造数据。')
  return lines.join('\n')
}
