import { describe, expect, it } from 'vitest'
import { cleanSessionName, summarizePromptTitle } from '../promptTitle'

describe('summarizePromptTitle', () => {
  it('keeps a short plain prompt as-is', () => {
    expect(summarizePromptTitle('帮我看看消耗为什么涨了', '链接')).toBe('帮我看看消耗为什么涨了')
  })

  it('caps a comma-free long prompt at 24 code points with an ellipsis', () => {
    const long = `${'账'.repeat(30)}看这里的投放需求`
    expect(summarizePromptTitle(long, '链接')).toBe(`${'账'.repeat(24)}…`)
  })

  it('takes the first fullwidth-comma clause of a long prompt', () => {
    expect(summarizePromptTitle('帮我按这个格式随便写一个飞书文档吧，要用标准流程处理这次的投放需求', '链接')).toBe(
      '帮我按这个格式随便写一个飞书文档吧'
    )
  })

  it('does not split a surrogate pair at the cap boundary', () => {
    // 23 CJK chars + one emoji = 24 code points, 25 code units.
    const prompt = `${'账'.repeat(23)}🚀再加两个字`
    const title = summarizePromptTitle(prompt, '链接')
    expect(Array.from(title).length).toBe(25) // 24 chars + ellipsis
    expect(title.endsWith('🚀…')).toBe(true)
  })

  it('prefers the first clause and drops the rest', () => {
    expect(summarizePromptTitle('先看下数据。然后写个总结。最后发我', '链接')).toBe('先看下数据')
  })

  it('collapses URLs to the localized placeholder', () => {
    expect(summarizePromptTitle('https://example.com/report?id=1 帮我分析这个报表', '链接')).toBe('链接 帮我分析这个报表')
    expect(summarizePromptTitle('analyze https://example.com/x please', 'link')).toBe('analyze link please')
  })

  it('stops a URL before unspaced CJK text that follows it', () => {
    expect(summarizePromptTitle('看下https://example.com/report的数据，然后写个总结', '链接')).toBe('看下链接的数据')
  })

  it('strips fenced code blocks and markdown noise but keeps identifiers', () => {
    const prompt = '```python\nprint(1)\n```\n帮我修一下 fix_snake_case 的问题'
    expect(summarizePromptTitle(prompt, '链接')).toBe('帮我修一下 fix_snake_case 的问题')
  })

  it('drops a leading slash command', () => {
    expect(summarizePromptTitle('/boards 帮我加个看板', '链接')).toBe('帮我加个看板')
  })

  it('falls back to the whole text when the first clause is degenerate', () => {
    expect(summarizePromptTitle('3.5 的方案帮我看看', '链接')).toBe('3.5 的方案帮我看看')
  })

  it('returns empty for content with nothing nameable', () => {
    expect(summarizePromptTitle('```js\nconst a = 1\n```', '链接')).toBe('')
    expect(summarizePromptTitle('   ', '链接')).toBe('')
  })
})

describe('cleanSessionName', () => {
  it('collapses all whitespace and caps at 60 chars', () => {
    expect(cleanSessionName('  a\r\nb\t c  ')).toBe('a b c')
    expect(cleanSessionName('x'.repeat(80)).length).toBe(60)
  })
})
