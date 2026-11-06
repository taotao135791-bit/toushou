/** Descriptive facts calculated from the current bound values, without causal claims. */
export type BoardAnalysisFact =
  | { kind: 'period'; value: number }
  | { kind: 'leader'; label: string; value: number }
  | { kind: 'change'; from: string; to: string; fromValue: number; toValue: number; percent: number | null }

export function deriveBoardAnalysis(input: {
  value: number | null
  groups?: Array<{ label: string; value: number }>
  temporal?: boolean
}): BoardAnalysisFact[] {
  if (input.value === null || !Number.isFinite(input.value)) return []
  const facts: BoardAnalysisFact[] = [{ kind: 'period', value: input.value }]
  const groups = input.groups ?? []
  if (!groups.length || groups.some(group => !group.label || !Number.isFinite(group.value))) return facts
  const sorted = input.temporal ? [...groups].sort((a, b) => a.label.localeCompare(b.label)) : groups
  if (input.temporal && sorted.length > 1 && sorted.every(group => /^\d{4}-\d{2}-\d{2}$/.test(group.label))) {
    const from = sorted[0], to = sorted[sorted.length - 1]
    facts.push({ kind: 'change', from: from.label, to: to.label, fromValue: from.value, toValue: to.value,
      percent: from.value > 0 ? (to.value - from.value) / from.value * 100 : null })
  }
  const leader = sorted.reduce((best, group) => group.value > best.value ? group : best)
  facts.push({ kind: 'leader', label: leader.label, value: leader.value })
  return facts.slice(0, 3)
}
