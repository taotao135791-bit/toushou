import { describe, expect, it } from 'vitest'
import { splitMcpMentions } from '@shared/mcpMentions'
import { planInvocation } from './composerInvocation'

describe('composer invocation insertion', () => {
  it('delimits an MCP mention at the caret and preserves both sides of the request', () => {
    const text = '检查近7天'
    const edit = planInvocation(text, 2, 2, { kind: 'mcp', name: 'tiktok-ads' })!
    const result = text.slice(0, edit.start) + edit.insert + text.slice(edit.end)
    expect(result).toBe('检查 @mcp:tiktok-ads 近7天')
    expect(splitMcpMentions(result).names).toEqual(['tiktok-ads'])
  })

  it('keeps a native command first even when the caret follows other text', () => {
    const slash = { kind: 'slash', command: '/ads' } as const
    expect(planInvocation('只查最近7天', 6, 6, slash)).toEqual({ start: 0, end: 0, insert: '/ads ' })
    expect(planInvocation(' /old  只查最近7天', 8, 8, slash)).toEqual({ start: 0, end: 7, insert: '/ads ' })
    expect(planInvocation('/tmp/report.csv', 15, 15, slash)).toEqual({ start: 0, end: 0, insert: '/ads ' })
  })

  it('detects incompatible slash and MCP selections before changing the draft', () => {
    expect(planInvocation('@mcp:tiktok-ads', 0, 0, { kind: 'slash', command: '/ads' })).toBeNull()
    const mcp = { kind: 'mcp', name: 'tiktok-ads' } as const
    expect(planInvocation('/ads 最近7天', 5, 5, mcp)).toBeNull()
    expect(planInvocation('/ads 最近7天', 0, 4, mcp)).toEqual({ start: 0, end: 4, insert: '@mcp:tiktok-ads ' })
  })
})
