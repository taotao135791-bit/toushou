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
  getCheckpoint
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
