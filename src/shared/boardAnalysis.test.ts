import { describe, expect, it } from 'vitest'
import { deriveBoardAnalysis } from './boardAnalysis'

describe('live descriptive board analysis', () => {
  it('uses the actual first and last dates and keeps a real peak', () => {
    const facts = deriveBoardAnalysis({ value: 42, temporal: true, groups: [
      { label: '2026-04-03', value: 12 }, { label: '2026-04-01', value: 6 }, { label: '2026-04-02', value: 24 }
    ] })
    expect(facts).toEqual([{ kind: 'period', value: 42 },
      { kind: 'change', from: '2026-04-01', to: '2026-04-03', fromValue: 6, toValue: 12, percent: 100 },
      { kind: 'leader', label: '2026-04-02', value: 24 }])
  })
  it('does not invent a percentage from a zero baseline or a missing value', () => {
    expect(deriveBoardAnalysis({ value: null, groups: [{ label: 'synthetic', value: 7 }] })).toEqual([])
    expect(deriveBoardAnalysis({ value: 7, temporal: true, groups: [{ label: '2026-04-01', value: 0 }, { label: '2026-04-02', value: 7 }] })[1]).toMatchObject({ percent: null })
  })
  it('recomputes rankings when bound values change without naming a business funnel', () => {
    const first = deriveBoardAnalysis({ value: 9, groups: [{ label: 'Synthetic A', value: 7 }, { label: 'Synthetic B', value: 2 }] })
    const next = deriveBoardAnalysis({ value: 12, groups: [{ label: 'Synthetic A', value: 3 }, { label: 'Synthetic B', value: 9 }] })
    expect(first[1]).toMatchObject({ label: 'Synthetic A', value: 7 })
    expect(next[1]).toMatchObject({ label: 'Synthetic B', value: 9 })
  })
})
