import { describe, it, expect } from 'vitest'
import { currentValueState } from './runtimeSelect'

describe('currentValueState', () => {
  it('empty current value is a genuine automatic/reset state, never unavailable', () => {
    expect(currentValueState('', ['a', 'b'])).toEqual({ value: '', unavailable: false })
  })

  it('current value present in choices is available', () => {
    expect(currentValueState('a', ['a', 'b'])).toEqual({ value: 'a', unavailable: false })
  })

  it('current value missing from choices stays visible as unavailable', () => {
    // runtime = old-model, catalog only has new-model
    expect(currentValueState('provider/old-model', ['provider/new-model'])).toEqual({
      value: 'provider/old-model',
      unavailable: true
    })
  })

  it('current thinking unsupported by the model is still visible as unavailable', () => {
    // runtime = xhigh, model supports medium/high
    expect(currentValueState('xhigh', ['auto', 'medium', 'high'])).toEqual({
      value: 'xhigh',
      unavailable: true
    })
  })
})