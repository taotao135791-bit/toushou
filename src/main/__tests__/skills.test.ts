import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import http from 'node:http'
import path from 'node:path'

// skills.ts resolves its default dir through electron's app.getPath and
// reveals through shell; tests inject explicit dirs instead.
let userDataDir: string
const showItemInFolder = vi.fn()
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  shell: { showItemInFolder: (...args: unknown[]) => showItemInFolder(...args) }
}))

import {
  importSkillFile,
  listSkills,
  deleteSkill,
  openSkillHtml,
  readSkill,
  readSkillSystemPrompt,
  revealSkillsDir,
  stopSkillsServerForTests
} from '../skills'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-skills-'))
  userDataDir = dir
})

afterEach(() => {
  stopSkillsServerForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('returns empty when the folder does not exist', () => {
    const result = listSkills(path.join(dir, 'missing'))
    expect(result).toEqual({ ok: true, entries: [] })
  })

  it('lists only library files, newest first, with metadata', () => {
    writeFileSync(path.join(dir, 'alpha.md'), ['---', 'name: Alpha 打法', 'author: A', '---', '', '第一段'].join(LINE_BREAK))
    writeFileSync(path.join(dir, 'beta.html'), '<p>工具</p>')
    writeFileSync(path.join(dir, 'notes.txt'), 'ignore me')
    const result = listSkills(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.id).sort()).toEqual(['alpha.md', 'beta.html'])
    const alpha = result.entries.find((e) => e.id === 'alpha.md')
    expect(alpha?.name).toBe('Alpha 打法')
    expect(alpha?.author).toBe('A')
    expect(result.entries[0].updatedAtMillis).toBeGreaterThanOrEqual(
      result.entries[1].updatedAtMillis
    )
  })
})

describe('readSkillSystemPrompt', () => {
  it('formats a markdown skill as a tagged system-prompt block', () => {
    writeFileSync(path.join(dir, '打法.md'), '# 第一步\n先看 CPI', 'utf-8')
    const result = readSkillSystemPrompt('打法.md', 'zh', dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.prompt).toContain('<team-skill name="打法">')
      expect(result.prompt).toContain('先看 CPI')
      expect(result.prompt.trim().endsWith('</team-skill>')).toBe(true)
    }
  })

  it('rejects html entries and unknown ids', () => {
    writeFileSync(path.join(dir, 'tool.html'), '<p>x</p>', 'utf-8')
    expect(readSkillSystemPrompt('tool.html', 'zh', dir)).toEqual({ ok: false, error: 'not-markdown' })
    expect(readSkillSystemPrompt('missing.md', 'zh', dir)).toEqual({ ok: false, error: 'not-found' })
    expect(readSkillSystemPrompt('../escape', 'zh', dir)).toEqual({ ok: false, error: 'invalid-request' })
  })

  it('truncates an oversized skill below the spawn-arg byte cap', () => {
    writeFileSync(path.join(dir, 'big.md'), '巨'.repeat(200 * 1024), 'utf-8')
    const result = readSkillSystemPrompt('big.md', 'zh', dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Buffer.byteLength(result.prompt, 'utf-8')).toBeLessThanOrEqual(240 * 1024)
      expect(result.prompt).toContain('[truncated: skill exceeds the 240 KB launch limit]')
      expect(result.prompt.trim().endsWith('</team-skill>')).toBe(true)
    }
  })
})

describe('deleteSkill', () => {
  it('deletes a markdown entry and leaves the rest untouched', () => {
    writeFileSync(path.join(dir, '打法.md'), '# x', 'utf-8')
    writeFileSync(path.join(dir, 'keep.html'), '<p>y</p>', 'utf-8')
    expect(deleteSkill('打法.md', dir)).toEqual({ ok: true })
    expect(listSkills(dir)).toEqual({
      ok: true,
      entries: [expect.objectContaining({ id: 'keep.html' })]
    })
  })

  it('rejects unknown ids and traversal', () => {
    expect(deleteSkill('missing.md', dir)).toEqual({ ok: false, error: 'not-found' })
    expect(deleteSkill('../escape.md', dir)).toEqual({ ok: false, error: 'invalid-request' })
  })
})

describe('readSkill', () => {
  it('rejects invalid ids and missing files', () => {
    expect(readSkill('../escape.md', dir)).toEqual({ ok: false, error: 'invalid-request' })
    expect(readSkill('missing.md', dir)).toEqual({ ok: false, error: 'not-found' })
  })

  it('reads a markdown file with its entry', () => {
    writeFileSync(path.join(dir, 'guide.md'), '# 指南' + LINE_BREAK + LINE_BREAK + '内容')
    const result = readSkill('guide.md', dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.kind).toBe('markdown')
    expect(result.content).toContain('指南')
  })
})

describe('importSkillFile', () => {
  it('copies a valid file in and reports its entry', () => {
    const source = path.join(dir, '..', 'source-' + process.pid + '.md')
    writeFileSync(source, ['---', 'name: 外部打法', '---', '', '内容'].join(LINE_BREAK))
    const result = importSkillFile(source, path.join(dir, 'lib'))
    rmSync(source, { force: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.id).toBe(path.basename(source))
    expect(result.entry.name).toBe('外部打法')
  })

  it('rejects wrong extensions, missing files and resolves collisions', () => {
    const txt = path.join(dir, 'a.txt')
    writeFileSync(txt, 'nope')
    expect(importSkillFile(txt, dir)).toEqual({ ok: false, error: 'invalid-file' })
    expect(importSkillFile(path.join(dir, 'gone.md'), dir)).toEqual({
      ok: false,
      error: 'invalid-path'
    })
    writeFileSync(path.join(dir, 'dup.md'), 'one')
    const src = path.join(dir, 'src-tmp.md')
    writeFileSync(src, 'two')
    const result = importSkillFile(src, dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.id).not.toBe('dup.md')
    expect(result.entry.id.endsWith('.md')).toBe(true)
  })
})

describe('revealSkillsDir', () => {
  it('creates the folder and reveals it', () => {
    expect(revealSkillsDir(path.join(dir, 'skills'))).toBe(true)
    expect(showItemInFolder).toHaveBeenCalled()
  })
})

describe('openSkillHtml (loopback server)', () => {
  it('serves library html only, pinned to the loopback host', async () => {
    writeFileSync(path.join(dir, 'tool.html'), '<!doctype html><p>tool</p>')
    writeFileSync(path.join(dir, 'doc.md'), '# doc')

    const result = await openSkillHtml('tool.html', dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const page = await fetch(result.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('tool')

    // Markdown ids are not servable HTML.
    const md = await openSkillHtml('doc.md', dir)
    expect(md).toEqual({ ok: false, error: 'invalid-request' })

    // A non-loopback Host header (DNS rebinding shape) is refused.
    const refused = await new Promise<number>((resolve) => {
      const req = http.request(result.url, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', () => resolve(0))
      req.end()
    })
    expect(refused).toBe(403)

    // Unknown ids 404 without touching disk outside the dir.
    const missing = await fetch(result.url.replace(/[^/]+$/, 'nope.html'))
    expect(missing.status).toBe(404)
    const traversal = await fetch(result.url + '%2F..%2Fescape.md')
    expect([400, 404]).toContain(traversal.status)
  }, 10_000)
})

const LINE_BREAK = '\n'
