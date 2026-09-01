import { describe, expect, it } from 'vitest'
import {
  isValidSkillId,
  parseSkillMetadata,
  sanitizeSkillFileName,
  skillExtensionOf,
  skillKindForExtension
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

const LINE_BREAK = '\n'
