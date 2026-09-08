import { describe, expect, it } from 'vitest'
import { filterSlashItems, groupSlashItems, SlashMenuItem } from './slashCommands'

const items: SlashMenuItem[] = [
  { name: 'new', description: '新建对话', source: 'app', run: () => undefined },
  { name: 'mcp', description: 'MCP 服务状态', source: 'app', run: () => undefined },
  { name: 'boards', description: '看板', source: 'app', run: () => undefined },
  { name: 'material', description: '素材研究流水线', source: 'skill' },
  { name: 'compact', description: '压缩上下文', source: 'prompt' }
]

describe('filterSlashItems', () => {
  it('returns the full list capped when query is null (menu just opened)', () => {
    const out = filterSlashItems(items, null, 4)
    expect(out).toHaveLength(4)
    expect(out[0].name).toBe('new')
  })

  it('ranks name prefix first', () => {
    const out = filterSlashItems(items, 'm')
    // 'compact' also contains 'm' (name-includes tier), after the prefixes.
    expect(out.map((i) => i.name)).toEqual(['mcp', 'material', 'compact'])
  })

  it('matches by two-char name substring only when no prefix hits', () => {
    const out = filterSlashItems(items, 'ma')
    expect(out.map((i) => i.name)).toEqual(['material'])
  })

  it('falls back to description substring', () => {
    const out = filterSlashItems(items, '压缩')
    expect(out.map((i) => i.name)).toEqual(['compact'])
  })

  it('returns empty for no match', () => {
    expect(filterSlashItems(items, 'zzz')).toEqual([])
  })
})

describe('groupSlashItems', () => {
  it('orders groups app → command → skill with labels', () => {
    const groups = groupSlashItems(items, { app: '命令', command: '命令', skill: '技能' })
    expect(groups.map((g) => g.label)).toEqual(['命令', '命令', '技能'])
    expect(groups[0].items.map((i) => i.name)).toEqual(['new', 'mcp', 'boards'])
    expect(groups[2].items.map((i) => i.name)).toEqual(['material'])
  })

  it('skips empty groups', () => {
    const groups = groupSlashItems([items[3]], { app: '命令', command: '命令', skill: '技能' })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('技能')
  })
})
