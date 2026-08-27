import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getGitInfo, getFileDiff } from '../gitinfo'

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-git-'))
  outside = mkdtempSync(path.join(tmpdir(), 'omp-outside-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('gitinfo symlink containment', () => {
  it('does not read the target of an untracked symlink escaping the repo', async () => {
    const secret = path.join(outside, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET\n'.repeat(100))
    symlinkSync(secret, path.join(dir, 'link'))

    const info = await getGitInfo(dir)
    const entry = info?.files.find((f) => f.path === 'link')
    // Untracked symlink escaping the repo → no +N badge (target never read).
    expect(entry?.status).toBe('untracked')
    expect(entry?.additions).toBeNull()

    // The synthetic diff must NOT leak the outside target's content.
    const diff = await getFileDiff(dir, 'link')
    expect(diff).not.toContain('TOP SECRET')
    expect(diff).toContain('symlink')
  })
})
