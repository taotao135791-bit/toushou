import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'memory-store-'))
const settings = vi.hoisted(() => ({ memoryStoragePath: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
// 存储位置设置：默认用例走空路径；自定义路径用例直接改 settings 状态。
vi.mock('../store', () => ({
  getStore: () => settings.memoryStoragePath,
  setStore: (_key: string, value: string) => { settings.memoryStoragePath = value }
}))

const { buildMemoryPrompt, changeMemoryStorage, deleteMemoryEntry, moveMemoryEntry, projectMemoryKey, readMemoryLayer, resetMemoryStorageToDefault, saveMemoryEntry, updateMemoryText } = await import('../memoryStore')

const PROJECT_A = 'D:\\工作\\组内协作开发'
const PROJECT_B = 'D:\\Documents\\投手工作区'

beforeEach(() => {
  rmSync(path.join(userData, 'memory'), { recursive: true, force: true })
})

describe('memory store (global/project layers)', () => {
  it('isolates project memory by working directory; global reaches every project', () => {
    expect(saveMemoryEntry({ text: '全局红线：禁用真实数据测试', scope: 'global' }).ok).toBe(true)
    expect(saveMemoryEntry({ text: 'AF 数据必须直连', scope: 'project', cwd: PROJECT_A }).ok).toBe(true)

    const seenInA = readMemoryLayer('project', projectMemoryKey(PROJECT_A))
    const seenInB = readMemoryLayer('project', projectMemoryKey(PROJECT_B))
    expect(seenInA.entries.map((e) => e.text)).toEqual(['AF 数据必须直连'])
    // 项目隔离：B 项目的记忆层为空，物理上读不到 A 的内容。
    expect(seenInB.entries).toEqual([])
    // 全局两层都可见。
    expect(readMemoryLayer('global', null).entries.map((e) => e.text)).toEqual(['全局红线：禁用真实数据测试'])
  })

  it('switches to a custom location with migration, and refuses to overwrite a non-empty target', () => {
    const custom = mkdtempSync(path.join(tmpdir(), 'memory-custom-'))
    rmSync(custom, { recursive: true, force: true }) // changeMemoryStorage 要求目标为空，自己建

    saveMemoryEntry({ text: '要跟着搬走的记忆', scope: 'global' })
    const result = changeMemoryStorage(custom, true)
    expect(result).toEqual({ ok: true, path: custom })
    settings.memoryStoragePath = custom

    // 新位置读得到迁移过来的内容；旧位置原样保留（备份不删）。
    expect(readMemoryLayer('global', null).entries.map((e) => e.text)).toEqual(['要跟着搬走的记忆'])
    expect(saveMemoryEntry({ text: '写在自定义位置的新记忆', scope: 'global' }).ok).toBe(true)
    expect(readMemoryLayer('global', null).entries).toHaveLength(2)

    // 目标非空拒绝（绝不覆盖既有数据）。
    const occupied = mkdtempSync(path.join(tmpdir(), 'memory-occupied-'))
    writeFileSync(path.join(occupied, 'something.txt'), 'user data', 'utf-8')
    expect(changeMemoryStorage(occupied, true)).toEqual({ ok: false, error: 'not-empty' })

    // 相同路径 / 指向默认目录拒绝。
    expect(changeMemoryStorage(custom, true)).toEqual({ ok: false, error: 'same-path' })
    expect(changeMemoryStorage(path.join(userData, 'memory'), true)).toEqual({ ok: false, error: 'default-target' })

    // 迁移回默认（默认处非空——第一次的备份在），不迁移只切开关。
    const reset = resetMemoryStorageToDefault(false)
    expect(reset.ok).toBe(true)
    settings.memoryStoragePath = ''
    expect(readMemoryLayer('global', null).entries.map((e) => e.text)).toContain('要跟着搬走的记忆')
  })

  it('rejects invalid text and dedupes verbatim repeats instead of growing noise', () => {    expect(saveMemoryEntry({ text: '   ', scope: 'global' }).ok).toBe(false)
    const first = saveMemoryEntry({ text: '看板只许手动刷新', scope: 'global' })
    const second = saveMemoryEntry({ text: '看板只许手动刷新', scope: 'global' })
    expect(first.ok && second.ok && second.duplicate).toBe(true)
    expect(second.ok && first.ok && second.entry.id === first.entry.id).toBe(true)
    expect(readMemoryLayer('global', null).entries).toHaveLength(1)
  })

  it('deletes, updates and moves entries between layers', () => {
    const saved = saveMemoryEntry({ text: '临时笔记', scope: 'project', cwd: PROJECT_A })
    expect(saved.ok).toBe(true)
    const id = saved.ok ? saved.entry.id : ''

    expect(updateMemoryText('project', id, '更新后的笔记', PROJECT_A)).toBe(true)
    expect(readMemoryLayer('project', projectMemoryKey(PROJECT_A)).entries[0].text).toBe('更新后的笔记')

    // 手动移动是跨层唯一通道：project → global。
    expect(moveMemoryEntry(id, 'project', 'global', PROJECT_A)).toBe(true)
    expect(readMemoryLayer('project', projectMemoryKey(PROJECT_A)).entries).toHaveLength(0)
    expect(readMemoryLayer('global', null).entries.map((e) => e.text)).toContain('更新后的笔记')

    expect(deleteMemoryEntry('global', id)).toBe(true)
    expect(readMemoryLayer('global', null).entries).toHaveLength(0)
  })

  it('degrades a corrupt file to empty entries and keeps the bytes for recovery', () => {
    const key = projectMemoryKey(PROJECT_A)
    saveMemoryEntry({ text: '要被弄坏的内容', scope: 'project', cwd: PROJECT_A })
    const file = path.join(userData, 'memory', 'projects', `${key}.json`)
    writeFileSync(file, '{"entries":[{"text":', 'utf-8')

    const layer = readMemoryLayer('project', key)
    expect(layer.entries).toEqual([])
    expect(layer.corrupt).toBe(true)
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe('{"entries":[{"text":')
  })

  it('buildMemoryPrompt injects global + current project only, never another project', () => {
    saveMemoryEntry({ text: '全局规矩甲', scope: 'global' })
    saveMemoryEntry({ text: '全局规矩乙', scope: 'global' })
    saveMemoryEntry({ text: 'A 项目的口径', scope: 'project', cwd: PROJECT_A })
    saveMemoryEntry({ text: 'B 项目的口径', scope: 'project', cwd: PROJECT_B })

    const promptA = buildMemoryPrompt(PROJECT_A)
    expect(promptA).toContain('全局规矩甲')
    expect(promptA).toContain('A 项目的口径')
    expect(promptA).not.toContain('B 项目的口径')

    const promptB = buildMemoryPrompt(PROJECT_B)
    expect(promptB).toContain('B 项目的口径')
    expect(promptB).not.toContain('A 项目的口径')

    // 没有任何项目记忆的新项目：全局记忆照常注入，项目层为空段。
    const fresh = buildMemoryPrompt('D:\\fresh-project')
    expect(fresh).toContain('全局规矩甲')
    expect(fresh).not.toContain('项目的口径')
  })

  it('drops oldest entries first when the prompt exceeds the byte budget, and says so', () => {
    for (let i = 0; i < 90; i++) {
      saveMemoryEntry({ text: `全局记忆第${i}条：${'很长的内容'.repeat(30)}`, scope: 'global' })
    }
    const prompt = buildMemoryPrompt(PROJECT_A)
    expect(prompt).not.toBeNull()
    expect(Buffer.byteLength(prompt ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024 + 400)
    // 最新的（编号大）留下，最旧的被裁并明确说明。
    expect(prompt).toContain('第89条')
    expect(prompt).not.toContain('第0条')
    expect(prompt).toMatch(/未注入|omitted/)
  })
})
