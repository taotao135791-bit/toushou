import { describe, it, expect } from 'vitest'
import { buildAgentArgs } from '../languageArgs'

describe('buildAgentArgs', () => {
  it('injects the Chinese ad-optimizer persona for zh', () => {
    const args = buildAgentArgs('zh')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('广告优化师')
    expect(args[1]).toContain('简体中文')
    expect(args[1]).toContain('投手')
  })

  it('injects the English ad-optimizer persona for en', () => {
    const args = buildAgentArgs('en')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('advertising-optimization agent')
  })
})
