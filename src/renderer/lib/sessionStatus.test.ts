import { describe, expect, it } from 'vitest'
import { getSessionStatus } from './sessionStatus'

describe('getSessionStatus', () => {
  it('prioritizes error over every live state', () => {
    expect(getSessionStatus({ error: true, waiting: true, busy: true, unread: true })).toBe('error')
  })

  it('prioritizes attention over running and unread', () => {
    expect(getSessionStatus({ error: false, waiting: true, busy: true, unread: true })).toBe('attention')
  })

  it('reports running and unread before idle', () => {
    expect(getSessionStatus({ error: false, waiting: false, busy: true, unread: true })).toBe('running')
    expect(getSessionStatus({ error: false, waiting: false, busy: false, unread: true })).toBe('unread')
    expect(getSessionStatus({ error: false, waiting: false, busy: false, unread: false })).toBe('idle')
  })
})

