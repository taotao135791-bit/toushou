import { describe, expect, it } from 'vitest'
import boardsTools from '../../../resources/boards-toolkit/extensions/index'

describe('conversation highlight tool guidance', () => {
  it('exposes evidence as read-only and requires review of proposed highlights', () => {
    const tools: Array<{ name: string; description: string; approval?: string }> = []
    boardsTools({ registerTool: tool => { tools.push(tool) } })
    const get = tools.find(tool => tool.name === 'toushou_board_get')
    expect(get?.approval).toBe('read')
    expect(get?.description).toContain('config.evidence')
    expect(get?.description).toContain('```board-highlights')
    expect(get?.description).toContain('用户审核')
    expect(get?.description).toContain('不得引用')
    expect(get?.description).toContain('不能由模型凭空创建')
  })
})
