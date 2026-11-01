import { describe, expect, it } from 'vitest'
import registerBoardsTools from '../../../resources/boards-toolkit/extensions/index'

describe('board toolkit prompt contract', () => {
  it('defaults to blank and explains saved-source previews without prescribing extra calls', () => {
    const registered: Array<{ name: string; description: string }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const create = registered.find(tool => tool.name === 'toushou_board_create')!
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    expect(create.description).toContain('默认创建空白看板')
    expect(create.description).toContain('只有用户明确要求读取时')
    expect(create.description).not.toContain('立即调用 touhou_tiktok_update')
    expect(add.description).toContain('已保存的 reading-snapshot 或 reading-module')
    expect(add.description).toContain('自动尝试在对话显示实际预览')
    expect(add.description).toContain('无需搜索源码、协议、执行 shell')
    expect(add.description).toContain('明确要求自定义 HTML 文件时')
  })
})
