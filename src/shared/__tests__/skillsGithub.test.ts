import { describe, expect, it } from 'vitest'
import { GITHUB_IMPORT_MAX_FILES, parseGithubSkillUrl, selectGithubSkillFiles } from '../skillsGithub'

describe('parseGithubSkillUrl', () => {
  it('parses bare repo links', () => {
    expect(parseGithubSkillUrl('https://github.com/taotao135791-bit/toushou')).toEqual({
      kind: 'repo',
      owner: 'taotao135791-bit',
      repo: 'toushou',
      ref: '',
      path: ''
    })
  })

  it('parses blob and raw file links with skill extensions', () => {
    expect(
      parseGithubSkillUrl('https://github.com/leo/skills/blob/main/docs/roi.md')
    ).toEqual({ kind: 'file', owner: 'leo', repo: 'skills', ref: 'main', path: 'docs/roi.md' })
    expect(
      parseGithubSkillUrl('https://raw.githubusercontent.com/leo/skills/main/tool.html')
    ).toEqual({ kind: 'file', owner: 'leo', repo: 'skills', ref: 'main', path: 'tool.html' })
  })

  it('rejects non-https, foreign hosts, traversal and wrong extensions', () => {
    expect(parseGithubSkillUrl('http://github.com/leo/skills')).toBeNull()
    expect(parseGithubSkillUrl('https://evil.com/leo/skills')).toBeNull()
    expect(parseGithubSkillUrl('https://github.com/../skills')).toBeNull()
    expect(parseGithubSkillUrl('https://github.com/leo/skills/blob/main/a.txt')).toBeNull()
    expect(parseGithubSkillUrl('https://github.com/leo/skills/blob/main/../secret.md')).toBeNull()
    expect(parseGithubSkillUrl('not a url')).toBeNull()
    expect(parseGithubSkillUrl(undefined)).toBeNull()
  })
})

describe('selectGithubSkillFiles', () => {
  it('auto-recognizes skills and filters noise', () => {
    const files = selectGithubSkillFiles([
      { path: 'README.md', sizeBytes: 100 },
      { path: 'playbooks/roi.md', sizeBytes: 200 },
      { path: 'tools/calc.html', sizeBytes: 300 },
      { path: 'src/app.ts', sizeBytes: 400 },
      { path: 'node_modules/lib/x.md', sizeBytes: 50 },
      { path: 'big.md', sizeBytes: 5 * 1024 * 1024 }
    ])
    expect(files.map((f) => f.path)).toEqual(['playbooks/roi.md', 'tools/calc.html'])
    expect(files[0].kind).toBe('markdown')
    expect(files[1].kind).toBe('html')
  })

  it('caps the recognized list', () => {
    const many = Array.from({ length: GITHUB_IMPORT_MAX_FILES + 20 }, (_, i) => ({
      path: 's' + i + '.md',
      sizeBytes: 1
    }))
    expect(selectGithubSkillFiles(many).length).toBe(GITHUB_IMPORT_MAX_FILES)
  })
})
