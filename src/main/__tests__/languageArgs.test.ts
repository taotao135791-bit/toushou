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

  it('appends a skill SOP inside the same system prompt arg', () => {
    const args = buildAgentArgs('zh', '<team-skill name="打法">步骤</team-skill>')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('--append-system-prompt')
    expect(args[1]).toContain('广告优化师')
    expect(args[1]).toContain('<team-skill name="打法">步骤</team-skill>')
    expect(args[1].indexOf('广告优化师')).toBeLessThan(args[1].indexOf('<team-skill'))
  })

  it('ignores a whitespace-only skill prompt', () => {
    const args = buildAgentArgs('zh', '   ')
    expect(args[1]).not.toContain('<team-skill')
  })
})
