import { describe, it, expect } from 'vitest'
import { defaultThinkingOptionsFor, sessionThinkingOptionsFor } from './thinking'

describe('sessionThinkingOptionsFor', () => {
  it('offers only the model-supported levels (plus off) on current profile', () => {
    expect(sessionThinkingOptionsFor('current', { thinking: ['medium', 'high'] })).toEqual([
      'off',
      'medium',
      'high'
    ])
    expect(sessionThinkingOptionsFor('current', { thinking: ['low', 'high', 'max'] })).toEqual([
      'off',
      'low',
      'high',
      'max'
    ])
  })

  it('orders by the canonical intensity order, not the catalog order', () => {
    expect(sessionThinkingOptionsFor('current', { thinking: ['max', 'low'] })).toEqual([
      'off',
      'low',
      'max'
    ])
  })

  it('falls back to the full session set when the model is unknown to the catalog', () => {
    expect(sessionThinkingOptionsFor('current', undefined)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(sessionThinkingOptionsFor('current', { thinking: [] })).toHaveLength(7)
  })

  it('legacy profile never offers max', () => {
    expect(sessionThinkingOptionsFor('legacy', undefined)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(sessionThinkingOptionsFor('legacy', { thinking: ['max'] })).not.toContain('max')
  })
})

describe('defaultThinkingOptionsFor', () => {
  it('offers the config enum (auto..max, no off) for an unknown model', () => {
    expect(defaultThinkingOptionsFor(undefined)).toEqual([
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('filters to the model-supported levels but always keeps auto', () => {
    expect(defaultThinkingOptionsFor({ thinking: ['medium', 'high'] })).toEqual([
      'auto',
      'medium',
      'high'
    ])
  })

  it('never includes off (not a legal config default)', () => {
    expect(defaultThinkingOptionsFor({ thinking: ['off', 'max'] })).toEqual(['auto', 'max'])
  })
})