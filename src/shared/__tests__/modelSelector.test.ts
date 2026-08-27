import { describe, it, expect } from 'vitest'
import {
  parseModelSelector,
  formatModelSelector,
  switchModelSelector
} from '../modelSelector'

describe('model selector thinking suffix', () => {
  it('parses a known :level suffix into a thinking override', () => {
    expect(parseModelSelector('openai/gpt-4o:high')).toEqual({
      modelSelector: 'openai/gpt-4o',
      thinkingOverride: 'high'
    })
    expect(parseModelSelector('openrouter/deepseek/model:max')).toEqual({
      modelSelector: 'openrouter/deepseek/model',
      thinkingOverride: 'max'
    })
  })

  it('returns the bare selector when there is no suffix', () => {
    expect(parseModelSelector('openai/gpt-4o')).toEqual({ modelSelector: 'openai/gpt-4o' })
    expect(parseModelSelector('openrouter/z-ai/glm-5.2')).toEqual({
      modelSelector: 'openrouter/z-ai/glm-5.2'
    })
  })

  it('does not mis-parse an unknown token as an override', () => {
    // A model id legitimately ending in :something (unknown token) round-trips.
    expect(parseModelSelector('openai/gpt-4o:custom')).toEqual({
      modelSelector: 'openai/gpt-4o:custom'
    })
  })

  it('returns null for empty input', () => {
    expect(parseModelSelector('')).toBeNull()
  })

  it('recombines parts back into a full selector', () => {
    expect(formatModelSelector({ modelSelector: 'openai/b', thinkingOverride: 'high' })).toBe(
      'openai/b:high'
    )
    expect(formatModelSelector({ modelSelector: 'openai/b' })).toBe('openai/b')
  })

  it('preserves a role-level override when switching only the model (A:high → B:high)', () => {
    expect(switchModelSelector('openai/a:high', 'openai/b')).toBe('openai/b:high')
  })

  it('lets an explicit new override win over the previous one', () => {
    expect(switchModelSelector('openai/a:high', 'openai/b:low')).toBe('openai/b:low')
  })

  it('switches cleanly when there was no previous override', () => {
    expect(switchModelSelector('openai/a', 'openai/b')).toBe('openai/b')
  })
})
