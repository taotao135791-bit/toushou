import { describe, expect, it } from 'vitest'
import { skillCardSummary } from './skillCardSummary'

describe('skill library previews', () => {
  it.each([
    'name: 竞品分析',
    '> 投手安装说明：打开完整参考文档',
    'Read `/Users/example/skill.md` for the full skill.',
    'Read `C:\\Users\\example\\skill.md` for the full skill.'
  ])('omits setup and metadata lines from cards: %s', (description) => {
    expect(skillCardSummary(description)).toBe('')
  })

  it('keeps the purpose and output with plain text formatting', () => {
    expect(skillCardSummary('> 比较 **素材**，生成 `CSV`。')).toBe('比较 素材，生成 CSV。')
    expect(skillCardSummary('Import / export CSV files.')).toBe('Import / export CSV files.')
  })
})
