import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// checkpoints.ts resolves the default store through electron's app.getPath;
// tests always inject an explicit file, so a minimal stub is enough.
vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(path.join(tmpdir(), 'omp-userdata-')) }
}))

import {
  createCheckpoint,
  restoreCheckpoint,
  saveCheckpoint,
  listCheckpoints,
  getCheckpoint,
  diffCheckpoint,
  parseNameStatusZ,
  parseNumstatLine
} from '../checkpoints'
import { CheckpointInfo } from '../../shared/types'

let repo: string
let storeFile: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' })
}

function commitAll(message: string): void {
  git(['add', '-A'])
  git(['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', message])
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'omp-checkpoint-repo-'))
  storeFile = path.join(mkdtempSync(path.join(tmpdir(), 'omp-checkpoint-store-')), 'checkpoints.json')
  git(['init'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(path.dirname(storeFile), { recursive: true, force: true })
})

describe('createCheckpoint / restoreCheckpoint', () => {
  it('restores modified files and deletes agent-created files', async () => {
    write('a.txt', 'original')
    commitAll('init')

    const cp = await createCheckpoint(repo)
    expect(cp).not.toBeNull()
    expect(cp!.untracked).toEqual([])

    write('a.txt', 'changed by agent')
    write('src/new-file.ts', 'export const x = 1')

    const result = await restoreCheckpoint(repo, cp!.sha, cp!.untracked)
    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('original')
    expect(existsSync(path.join(repo, 'src/new-file.ts'))).toBe(false)
    // the directory made empty by the deletion is cleaned up too
    expect(existsSync(path.join(repo, 'src'))).toBe(false)
  })

  it('keeps untracked files that existed at checkpoint time', async () => {
    write('tracked.txt', 'v1')
    commitAll('init')
    write('notes.txt', 'pre-existing scratch file')

    const cp = await createCheckpoint(repo)
    expect(cp!.untracked).toEqual(['notes.txt'])

    write('agent-output.txt', 'created after checkpoint')

    const result = await restoreCheckpoint(repo, cp!.sha, cp!.untracked)
    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toBe('pre-existing scratch file')
    expect(existsSync(path.join(repo, 'agent-output.txt'))).toBe(false)
  })

  it('does not touch the user index, stash or refs', async () => {
    write('a.txt', 'one')
    commitAll('init')
    const headBefore = git(['rev-parse', 'HEAD']).trim()
    const refsBefore = git(['for-each-ref']).trim()

    const cp = await createCheckpoint(repo)
    expect(cp).not.toBeNull()

    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(git(['for-each-ref']).trim()).toBe(refsBefore)
    expect(git(['stash', 'list']).trim()).toBe('')
    expect(git(['status', '--porcelain']).trim()).toBe('')
  })

  it('works in a repo with no commits yet', async () => {
    write('a.txt', 'content')
    const cp = await createCheckpoint(repo)
    expect(cp).not.toBeNull()

    write('a.txt', 'modified')
    const result = await restoreCheckpoint(repo, cp!.sha, cp!.untracked)
    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('content')
  })

  it('returns null for a non-git directory', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'omp-not-a-repo-'))
    try {
      expect(await createCheckpoint(plain)).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('persistence', () => {
  function entry(id: string, sessionId: string): CheckpointInfo {
    return {
      id,
      sessionId,
      sha: 'abc123',
      untracked: [],
      promptPreview: 'do something',
      msgIndex: 0,
      createdAt: Date.now()
    }
  }

  it('saves, lists and gets checkpoints per session', () => {
    saveCheckpoint(entry('c1', 's1'), storeFile)
    saveCheckpoint(entry('c2', 's1'), storeFile)
    saveCheckpoint(entry('c3', 's2'), storeFile)

    expect(listCheckpoints('s1', storeFile).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(getCheckpoint('c3', storeFile)?.sessionId).toBe('s2')
    expect(getCheckpoint('missing', storeFile)).toBeNull()
  })

  it('returns empty results when the store file is missing or corrupt', () => {
    expect(listCheckpoints('s1', storeFile)).toEqual([])
    writeFileSync(storeFile, '{broken')
    expect(listCheckpoints('s1', storeFile)).toEqual([])
  })
})

describe('parseNameStatusZ', () => {
  it('parses added / modified / deleted records', () => {
    expect(parseNameStatusZ('A\0new.txt\0M\0src/a.ts\0D\0old.txt\0')).toEqual([
      { path: 'new.txt', status: 'added' },
      { path: 'src/a.ts', status: 'modified' },
      { path: 'old.txt', status: 'deleted' }
    ])
  })

  it('collapses renames and copies to modified on the destination path', () => {
    expect(parseNameStatusZ('R100\0old-name.ts\0new-name.ts\0')).toEqual([
      { path: 'new-name.ts', status: 'modified' }
    ])
    expect(parseNameStatusZ('C75\0src/a.ts\0dst/b.ts\0')).toEqual([
      { path: 'dst/b.ts', status: 'modified' }
    ])
  })

  it('degrades type changes and unknown codes to modified, tolerates trailing NUL', () => {
    expect(parseNameStatusZ('T\0link.txt\0X9\0weird.txt\0')).toEqual([
      { path: 'link.txt', status: 'modified' },
      { path: 'weird.txt', status: 'modified' }
    ])
    expect(parseNameStatusZ('')).toEqual([])
    expect(parseNameStatusZ('M\0a.txt\0')).toEqual([{ path: 'a.txt', status: 'modified' }])
  })
})

describe('parseNumstatLine', () => {
  it('parses counts and paths, maps binary markers to null', () => {
    expect(parseNumstatLine('12\t3\tsrc/a.ts')).toEqual({
      additions: 12,
      deletions: 3,
      path: 'src/a.ts'
    })
    expect(parseNumstatLine('-\t-\tpicture.png')).toEqual({
      additions: null,
      deletions: null,
      path: 'picture.png'
    })
    expect(parseNumstatLine('0\t0\0weird')).toBeNull()
    expect(parseNumstatLine('not a numstat line')).toBeNull()
    expect(parseNumstatLine('')).toBeNull()
  })
})

describe('diffCheckpoint', () => {
  it('summarizes everything since the snapshot, including agent-created files', async () => {
    write('a.txt', 'original')
    write('gone.txt', 'will be deleted')
    commitAll('init')

    const cp = await createCheckpoint(repo)
    expect(cp).not.toBeNull()

    write('a.txt', 'changed by agent')
    write('src/created-by-agent.ts', 'export const x = 1')
    rmSync(path.join(repo, 'gone.txt'))

    const diff = await diffCheckpoint(repo, cp!.sha)
    expect(diff).not.toBeNull()
    const byPath = new Map(diff!.files.map((f) => [f.path, f]))
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified' })
    expect(byPath.get('src/created-by-agent.ts')).toMatchObject({ status: 'added' })
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted' })
    // untracked creations are invisible to a plain `git diff <sha>`; the
    // tree-to-tree comparison must catch them
    expect(diff!.files).toHaveLength(3)
    expect(diff!.additions).toBeGreaterThan(0)
  })

  it('returns empty files when the worktree matches the snapshot', async () => {
    write('a.txt', 'same')
    commitAll('init')
    const cp = await createCheckpoint(repo)
    const diff = await diffCheckpoint(repo, cp!.sha)
    expect(diff).toEqual({ files: [], additions: 0, deletions: 0 })
  })

  it('returns null for non-git directories and unknown shas', async () => {
    write('a.txt', 'content')
    commitAll('init')
    expect(await diffCheckpoint(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()

    const plain = mkdtempSync(path.join(tmpdir(), 'omp-not-a-repo-'))
    try {
      writeFileSync(path.join(plain, 'a.txt'), 'content')
      expect(await diffCheckpoint(plain, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
