import { describe, expect, it } from 'vitest'
import {
  isValidSkillId,
  parseSkillMetadata,
  sanitizeSkillFileName,
  skillExtensionOf,
  skillKindForExtension,
  formatSkillChatReference,
  formatSkillChatMessage,
  formatSkillSystemPrompt,
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

describe('formatSkillSystemPrompt', () => {
  it('strips front matter and wraps a Chinese SOP in team-skill tags', () => {
    const raw = ['---', 'name: 起量打法', 'author: Leo', '---', '', '# 第一步', '先看 CPI'].join('\n')
    expect(stripSkillFrontMatter(raw)).toContain('# 第一步')
    expect(stripSkillFrontMatter(raw)).not.toContain('author: Leo')
    const prompt = formatSkillSystemPrompt('起量打法', raw, 'zh')
    expect(prompt).toContain('<team-skill name="起量打法">')
    expect(prompt).toContain('请严格按它执行')
    expect(prompt).toContain('先看 CPI')
    expect(prompt.trim().endsWith('</team-skill>')).toBe(true)
    expect(prompt).not.toContain('author: Leo')
  })

  it('uses the English wrapper when language is en', () => {
    const prompt = formatSkillSystemPrompt('ROI tool', 'Check ROAS first.', 'en')
    expect(prompt).toContain('<team-skill name="ROI tool">')
    expect(prompt).toContain('Follow it exactly')
    expect(prompt).toContain('Check ROAS first.')
  })

  it('escapes quotes in the name attribute', () => {
    const prompt = formatSkillSystemPrompt('打"法"', '步骤', 'zh')
    expect(prompt).toContain('<team-skill name="打&quot;法&quot;">')
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
    const prompt = formatSkillSystemPrompt('对话联动测试', raw, 'zh')
    expect(prompt).toContain('<team-skill name="对话联动测试">')
    expect(prompt).toContain('SKILL_CHAT_OK')
    expect(prompt).not.toContain('author: Codex')
  })
})

describe('formatSkillChatReference', () => {
  it('references the loaded skill without pasting the body', () => {
    const zh = formatSkillChatReference('起量打法', 'zh')
    expect(zh).toContain('《起量打法》')
    expect(zh).toContain('SOP')
    expect(zh).not.toContain('<team-skill')
    const en = formatSkillChatReference('ROI tool', 'en')
    expect(en).toContain('"ROI tool"')
    expect(en).toContain('SOP')
  })
})

describe('formatSkillChatMessage', () => {
  it('sends the full SOP with a follow-it instruction for existing chats', () => {
    const raw = ['---', 'name: 起量打法', '---', '# 第一步', '先看 CPI'].join('\n')
    const message = formatSkillChatMessage('起量打法', raw, 'zh')
    expect(message).toContain('接下来请严格按这份团队打法')
    expect(message).toContain('# 起量打法')
    expect(message).toContain('先看 CPI')
    expect(message).not.toContain('name: 起量打法')
  })

  it('uses the English wrapper when language is en', () => {
    const message = formatSkillChatMessage('ROI tool', 'Check ROAS first.', 'en')
    expect(message).toContain('Follow this team skill/playbook exactly')
    expect(message).toContain('Check ROAS first.')
  })
})

const LINE_BREAK = '\n'
