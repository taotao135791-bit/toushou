import { describe, expect, it } from 'vitest'
import { estimatedTurnProgress } from './turnProgress'

describe('estimatedTurnProgress', () => {
  it('advances from left to right during a task without a plan', () => {
    const durations = [0, 1, 5, 15, 30, 60, 90, 120, 300, 3600]
    const widths = durations.map(elapsed => estimatedTurnProgress(elapsed).percent)
    expect(widths.every(percent => percent >= 0 && percent < 100)).toBe(true)
    expect(widths[0]).toBeLessThan(widths[4])
    expect(widths).toEqual([...widths].sort((left, right) => left - right))
  })

  it('counts down an approximate remaining time for ordinary work', () => {
    const early = estimatedTurnProgress(5, undefined, undefined, 60)
    const later = estimatedTurnProgress(25, undefined, undefined, 60)
    expect(early.remainingSeconds).toBeGreaterThan(0)
    expect(later.remainingSeconds).toBeGreaterThan(0)
    expect(later.remainingSeconds).toBeLessThan(early.remainingSeconds ?? 0)
  })

  it('uses an observed plan estimate when available', () => {
    const generic = estimatedTurnProgress(12, undefined, undefined, 60)
    const planned = estimatedTurnProgress(12, 60, 19, 60)
    expect(planned.remainingSeconds).toBe(19)
    expect(planned.percent).toBeGreaterThan(generic.percent)
  })

  it('reserves room for the reply even when all plan tasks are complete', () => {
    const result = estimatedTurnProgress(35, 100, undefined, 60)
    expect(result.percent).toBeGreaterThan(0)
    expect(result.percent).toBeLessThan(100)
  })

  it('stops the expired countdown while measured progress can still advance', () => {
    const overrun = estimatedTurnProgress(75, undefined, undefined, 60)
    const nearlyDone = estimatedTurnProgress(80, 97, undefined, 60)
    const planComplete = estimatedTurnProgress(85, 100, undefined, 60)
    expect(overrun.remainingSeconds).toBeUndefined()
    expect(nearlyDone.remainingSeconds).toBeUndefined()
    expect(planComplete.remainingSeconds).toBeUndefined()
    expect(nearlyDone.percent).toBeGreaterThan(overrun.percent)
    expect(planComplete.percent).toBe(98)
  })

  it('uses bounded fallback values when timing and measurements are invalid', () => {
    const fallback = estimatedTurnProgress(0)
    const invalid = estimatedTurnProgress(Number.NaN, Number.NaN, -1, Number.POSITIVE_INFINITY)
    expect(invalid).toEqual(fallback)
    expect(Number.isFinite(invalid.percent)).toBe(true)
    expect(invalid.remainingSeconds).toBeGreaterThan(0)
  })
})
