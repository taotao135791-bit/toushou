import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/mock/userData' } }))

import { hashedSessionDirCandidatesFor, sessionDirCandidatesFor } from '../sessionHistory'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'

describe('hashed session dir layout (OMP 17.2+)', () => {
  it('names home projects home-<basename>-<sha256(realpath)>', () => {
    // A path inside $HOME that does not exist: realpath falls back to resolve.
    const project = path.join(homedir(), 'does-not-exist-toushou')
    const name = path.basename(hashedSessionDirCandidatesFor(project, '/mock/agent')[0])
    expect(name.startsWith('home-does-not-exist-toushou-')).toBe(true)
    const expectedHash = createHash('sha256').update(project).digest('hex')
    expect(name.endsWith(expectedHash)).toBe(true)
  })

  it('keeps the legacy slug candidates alongside the hashed one', () => {
    const project = path.join(tmpdir(), 'some-project')
    const candidates = sessionDirCandidatesFor(project, '/mock/agent')
    // hashed (raw + sanitized label) + current slug + legacy slug, deduplicated
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(new Set(candidates.map((c) => path.basename(c))).size).toBe(candidates.length)
  })

  // Disk-verified (v0.9.0 bug report): the runtime sanitizes the hashed dir's
  // label to ASCII — three distinct pure-CJK projects all landed in
  // `home-project-<sha256(realpath)>`. Without the sanitized candidate the GUI
  // cannot list, resume or authorize deletes for those workspaces at all.
  it('mirrors the runtime label sanitization for non-ASCII project names', () => {
    const project = path.join(homedir(), '投手工作区-测试')
    const hash = createHash('sha256').update(project).digest('hex')
    const candidates = hashedSessionDirCandidatesFor(project, '/mock/agent')
    expect(candidates).toHaveLength(2)
    expect(path.basename(candidates[0])).toBe(`home-投手工作区-测试-${hash}`)
    // Sanitized (CJK stripped) label keeps a dash — the runtime's own output
    // for mixed names; empty labels fall through to the next case.
    expect(path.basename(candidates[1])).toBe(`home---${hash}`)
  })

  it('falls back to the project label when sanitization empties the basename', () => {
    const project = path.join(homedir(), '投手工作区')
    const hash = createHash('sha256').update(project).digest('hex')
    const candidates = hashedSessionDirCandidatesFor(project, '/mock/agent')
    expect(candidates).toHaveLength(2)
    expect(path.basename(candidates[1])).toBe(`home-project-${hash}`)
  })
})
