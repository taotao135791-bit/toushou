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
    // hashed + current slug + legacy slug, deduplicated
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    expect(new Set(candidates.map((c) => path.basename(c))).size).toBe(candidates.length)
  })
})
