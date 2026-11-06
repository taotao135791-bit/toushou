import { describe, expect, it } from 'vitest'
import registerBoardsTools from '../../../resources/boards-toolkit/extensions/index'

describe('board toolkit prompt contract', () => {
  it('defaults to blank and explains saved-source previews without prescribing extra calls', () => {
    const registered: Array<{ name: string; description: string }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const create = registered.find(tool => tool.name === 'toushou_board_create')!
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    expect(create.description).toContain('默认创建空白看板')
    expect(create.description).toContain('默认使用本地前端模块')
    expect(create.description).toContain('必须选 tiktok')
    expect(create.description).toContain('Meta Ads/MCP 看板选 meta')
    expect(create.description).toContain('meta-reading 和自动绑定的卡片')
    expect(create.description).toContain('缺失指标不补零')
    expect(add.description).toContain('只有用户明确要求自定义 HTML 文件时才可添加 file')
    expect(create.description).toContain('只有用户明确要求读取时')
    expect(create.description).not.toContain('立即调用 touhou_tiktok_update')
    expect(add.description).toContain('已保存的 reading-snapshot 或 reading-module')
    expect(add.description).toContain('自动尝试在对话显示实际预览')
    expect(add.description).toContain('无需搜索源码、协议、执行 shell')
    expect(add.description).toContain('明确要求自定义 HTML 文件时')
    expect(add.description).toContain('{"filePath":"report.html"}')
  })
  it('provides the exact file widget path contract to the model', () => {
    const registered: Array<{ name: string; parameters: unknown }> = []
    registerBoardsTools({ registerTool: tool => { registered.push(tool) } })
    const add = registered.find(tool => tool.name === 'toushou_board_add_widget')!
    const params = add.parameters as { properties: { config: { description: string } } }
    const hint = params.properties.config.description
    expect(hint).toContain('{"filePath":"report.html"}')
    expect(hint).toContain('已授权工作区内的相对路径')
    expect(hint).toContain('不要使用 path、file 或 src')
  })
})
