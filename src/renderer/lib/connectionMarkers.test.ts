import { describe, expect, it } from 'vitest'
import { splitConnectionMarkers } from './connectionMarkers'

describe('splitConnectionMarkers', () => {
  it('strips standalone marker lines and collects their kinds', () => {
    const { clean, guides } = splitConnectionMarkers(
      '需要额外授权才能继续。\n[[connect:feishu]]\n请补齐后重试。\n\n[[connect:mcp]]\n'
    )
    expect(guides.sort()).toEqual(['feishu', 'mcp'])
    expect(clean).not.toContain('[[connect:')
    expect(clean).toContain('需要额外授权才能继续。')
  })

  it('leaves inline mentions untouched — only own-line markers count', () => {
    const { clean, guides } = splitConnectionMarkers('格式是 [[connect:feishu]] 这样一行内的引用')
    expect(guides).toEqual([])
    expect(clean).toContain('[[connect:feishu]]')
  })

  it('is resilient to empty and non-string input', () => {
    expect(splitConnectionMarkers('')).toEqual({ clean: '', guides: [] })
    expect(splitConnectionMarkers(undefined as unknown as string).clean).toBe('')
  })
})
