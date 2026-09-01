import { describe, expect, it } from 'vitest'
import {
  isValidSkillId,
  parseSkillMetadata,
  sanitizeSkillFileName,
  skillExtensionOf,
  skillKindForExtension,
  formatSkillChatPrompt,
  stripSkillFrontMatter
} from '../skills'

describe('skillExtensionOf / skillKindForExtension', () => {
  it('accepts only md and html', () => {
    expect(skillExtensionOf('a.md')).toBe('md')
    expect(skillExtensionOf('a.HTML')).toBe('html')
    expect(skillExtensionOf('a.txt')).toBeNull()
    expect(skillExtensionOf('.md')).toBeNull()
    expect(skillExtensionOf('noext')).toBeNull()
    expect(skillKindForExtension('md')).toBe('markdown')
    expect(skillKindForExtension('html')).toBe('html')
    expect(skillKindForExtension('txt')).toBeNull()
  })
})

describe('isValidSkillId', () => {
  it('accepts safe basenames with a library extension', () => {
    expect(isValidSkillId('playbook.md')).toBe(true)
    expect(isValidSkillId('ROI calculator 2.html')).toBe(true)
    expect(isValidSkillId('投放打法.md')).toBe(true)
  })

  it('rejects traversal, hidden files, bad extensions and non-strings', () => {
    expect(isValidSkillId('../secret.md')).toBe(false)
    expect(isValidSkillId('a/b.md')).toBe(false)
    expect(isValidSkillId('.hidden.md')).toBe(false)
    expect(isValidSkillId('notes.txt')).toBe(false)
    expect(isValidSkillId('')).toBe(false)
    expect(isValidSkillId(42)).toBe(false)
    expect(isValidSkillId(null)).toBe(false)
    expect(isValidSkillId('x'.repeat(200) + '.md')).toBe(false)
  })
})

describe('sanitizeSkillFileName', () => {
  it('keeps the extension and cleans the stem', () => {
    expect(sanitizeSkillFileName('我的 打法.md')).toBe('我的 打法.md')
    expect(sanitizeSkillFileName('/etc/passwd.md')).toBe('passwd.md')
    expect(sanitizeSkillFileName('weird$name?.html')).toBe('weird$name-.html')
  })

  it('rejects non-strings and wrong extensions', () => {
    expect(sanitizeSkillFileName('a.txt')).toBeNull()
    expect(sanitizeSkillFileName('')).toBeNull()
    expect(sanitizeSkillFileName(undefined)).toBeNull()
  })
})

describe('parseSkillMetadata', () => {
  it('reads name/author/description from front matter', () => {
    const meta = parseSkillMetadata(
      ['---', 'name: TikTok 起量打法', 'author: Leo', 'description: 三天冷启动 SOP', '---', '', '# 内容'].join(LINE_BREAK),
      'tiktok.md'
    )
    expect(meta.name).toBe('TikTok 起量打法')
    expect(meta.author).toBe('Leo')
    expect(meta.description).toBe('三天冷启动 SOP')
  })

  it('falls back to the file stem and first meaningful line', () => {
    const meta = parseSkillMetadata(
      ['# 标题', '', '这是第一段说明文字。', '', '正文'].join(LINE_BREAK),
      'roi-tool.md'
    )
    expect(meta.name).toBe('roi tool')
    expect(meta.description).toBe('这是第一段说明文字。')
  })

  it('clips long values and never throws on html', () => {
    const meta = parseSkillMetadata(
      '<!doctype html><html><head><title>工具</title></head><body><p>一个自动化小工具</p></body></html>',
      'tool.html'
    )
    expect(meta.name).toBe('tool')
    expect(meta.description.length).toBeLessThanOrEqual(160)
  })
})

describe('formatSkillChatPrompt', () => {
  it('strips front matter and wraps a Chinese SOP prompt', () => {
    const raw = ['---', 'name: 起量打法', 'author: Leo', '---', '', '# 第一步', '先看 CPI'].join('\n')
    expect(stripSkillFrontMatter(raw)).toContain('# 第一步')
    expect(stripSkillFrontMatter(raw)).not.toContain('author: Leo')
    const prompt = formatSkillChatPrompt('起量打法', raw, 'zh')
    expect(prompt).toContain('请严格按下面这份团队打法')
    expect(prompt).toContain('# 起量打法')
    expect(prompt).toContain('先看 CPI')
    expect(prompt).not.toContain('author: Leo')
  })

  it('uses the English wrapper when language is en', () => {
    const prompt = formatSkillChatPrompt('ROI tool', 'Check ROAS first.', 'en')
    expect(prompt).toContain('Follow this team skill/playbook exactly')
    expect(prompt).toContain('# ROI tool')
    expect(prompt).toContain('Check ROAS first.')
  })

  it('wraps the live test SOP file the same way the UI will', async () => {
    const { readFileSync } = await import('node:fs')
    const file = '/Users/leo/Library/Application Support/toushou/skills/对话联动测试.md'
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      return
    }
    const prompt = formatSkillChatPrompt('对话联动测试', raw, 'zh')
    expect(prompt.startsWith('请严格按下面这份团队打法')).toBe(true)
    expect(prompt).toContain('# 对话联动测试')
    expect(prompt).toContain('SKILL_CHAT_OK')
    expect(prompt).not.toContain('author: Codex')
  })
})

const LINE_BREAK = '\n'
