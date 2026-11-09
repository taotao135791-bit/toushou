import { describe, expect, it } from 'vitest'
import { managedReadingStatus } from './readingStatus'

describe('managedReadingStatus', () => {
  it('keeps a completed plan status when one is still valid', () => {
    expect(managedReadingStatus({ viewStatus: 'updated', planPending: false, failed: false })).toBe('updated')
    expect(managedReadingStatus({ viewStatus: 'empty', planPending: true, failed: false })).toBe('empty')
    // A previous plan's failure survives until a new plan replaces it.
    expect(managedReadingStatus({ viewStatus: 'failed', planPending: false, failed: true })).toBe('failed')
  })

  it('is pending only while a refresh plan is actually running', () => {
    expect(managedReadingStatus({ planPending: true, failed: false })).toBe('pending')
    expect(managedReadingStatus({ planPending: true, failed: true })).toBe('pending')
  })

  it('is stale, not pending, after a date change clears the plan', () => {
    // Regression: a successful read followed by a master date change drops the
    // plan view without failing. Falling back to pending spun the module's own
    // refresh button and disabled it with nothing in flight.
    expect(managedReadingStatus({ planPending: false, failed: false })).toBe('stale')
  })

  it('reports a failure only when the last plan failed for this source', () => {
    expect(managedReadingStatus({ planPending: false, failed: true })).toBe('failed')
  })
})
