import { describe, it, expect } from 'vitest'
import { isValidModelSelector, splitModelSelector } from '../omp/settings/modelSelector'

/**
 * The single model-selector validation helper used by all Current OMP model
 * selector IPC paths. Slash-containing model selectors must round-trip
 * through validation and splitting untouched; validation only guards safety,
 * never upstream naming rules.
 */
describe('model selector validation & splitting', () => {
  it('accepts simple provider/model selectors', () => {
    expect(splitModelSelector('openai/gpt-x')).toEqual({ provider: 'openai', modelId: 'gpt-x' })
    expect(splitModelSelector('deepseek/deepseek-v4-flash')).toEqual({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash'
    })
  })

  it('accepts multi-slash selectors whose model id contains slashes', () => {
    expect(splitModelSelector('openrouter/deepseek/deepseek-v4-flash-0731')).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash-0731'
    })
    expect(splitModelSelector('openrouter/z-ai/glm-5.2')).toEqual({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.2'
    })
    expect(splitModelSelector('foo/bar/baz/qux')).toEqual({
      provider: 'foo',
      modelId: 'bar/baz/qux'
    })
  })

  it('accepts upstream-legal characters (dots, dashes, underscores, colons, @)', () => {
    expect(isValidModelSelector('openai/gpt-5.2')).toBe(true)
    expect(isValidModelSelector('x/y_z-1.5')).toBe(true)
    expect(isValidModelSelector('openai/gpt-4o:high')).toBe(true)
    expect(isValidModelSelector('openrouter/models/user@example/model')).toBe(true)
  })

  it('rejects unsafe shapes without touching upstream naming rules', () => {
    expect(isValidModelSelector('')).toBe(false)
    expect(isValidModelSelector('-rf')).toBe(false) // flag-like
    expect(isValidModelSelector('--model')).toBe(false)
    expect(isValidModelSelector('a\0b')).toBe(false) // null byte
    expect(isValidModelSelector('a\nb')).toBe(false) // control char
    expect(isValidModelSelector('x'.repeat(301))).toBe(false) // unbounded
    expect(isValidModelSelector('a b/c')).toBe(false) // space splits argv
  })

  it('splitting refuses provider-less or model-less selectors', () => {
    expect(splitModelSelector('noslash')).toBeNull() // only provider, no id
    expect(splitModelSelector('provider/')).toBeNull()
    expect(splitModelSelector('/model')).toBeNull()
  })
})