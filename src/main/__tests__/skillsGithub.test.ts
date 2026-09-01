import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { importGithubSkills, previewGithubSkills } from '../skillsGithub'
import { listSkills } from '../skills'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-skills-gh-'))
  userDataDir = dir
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('previewGithubSkills', () => {
  it('resolves the default branch and auto-recognizes skill files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/repos/leo/skills')) {
          if (u.includes('/git/trees/')) {
            return jsonResponse({
              tree: [
                { type: 'blob', path: 'README.md', size: 10 },
                { type: 'blob', path: 'playbook.md', size: 20 },
                { type: 'blob', path: 'tool.html', size: 30 },
                { type: 'tree', path: 'docs', size: 0 }
              ]
            })
          }
          return jsonResponse({ default_branch: 'main' })
        }
        return new Response('nope', { status: 404 })
      })
    )
    const result = await previewGithubSkills('https://github.com/leo/skills')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.ref).toBe('main')
    expect(result.files.map((f) => f.path)).toEqual(['playbook.md', 'tool.html'])
  })

  it('maps API failures to typed errors', async () => {
    expect(await previewGithubSkills('https://example.com/x')).toEqual({
      ok: false,
      error: 'invalid-url'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 }))
    )
    expect(await previewGithubSkills('https://github.com/leo/missing')).toEqual({
      ok: false,
      error: 'repo-not-found'
    })
  })
})

describe('importGithubSkills', () => {
  it('downloads selected files into the library and reports skips', async () => {
    writeFileSync(path.join(dir, 'dup.md'), 'already here')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.endsWith('/playbook.md')) return new Response('# 打法')
        if (u.endsWith('/huge.html')) {
          return new Response('<p>big</p>', {
            headers: { 'content-length': String(5 * 1024 * 1024) }
          })
        }
        if (u.endsWith('/gone.md')) return new Response('404', { status: 404 })
        return new Response('bad', { status: 500 })
      })
    )
    const result = await importGithubSkills(
      {
        source: { kind: 'repo', owner: 'leo', repo: 'skills', ref: 'main' },
        paths: ['playbook.md', 'huge.html', 'gone.md', '../escape.md']
      },
      dir
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.imported.map((e) => e.name)).toContain('playbook')
    expect(result.skipped).toEqual([
      { path: 'huge.html', reason: 'too-large' },
      { path: 'gone.md', reason: 'fetch-failed' },
      { path: '../escape.md', reason: 'invalid-file' }
    ])
    const library = listSkills(dir)
    expect(library.ok).toBe(true)
    if (!library.ok) return
    expect(library.entries.some((e) => e.id === 'playbook.md')).toBe(true)
  })

  it('rejects malformed requests outright', async () => {
    expect(await importGithubSkills(null, dir)).toEqual({ ok: false, error: 'invalid-request' })
    expect(
      await importGithubSkills({ source: { kind: 'repo', owner: '../x', repo: 'y', ref: 'main' }, paths: ['a.md'] }, dir)
    ).toEqual({ ok: false, error: 'invalid-request' })
    expect(
      await importGithubSkills({ source: { kind: 'repo', owner: 'leo', repo: 'skills', ref: 'main' }, paths: [] }, dir)
    ).toEqual({ ok: false, error: 'invalid-request' })
  })
})
