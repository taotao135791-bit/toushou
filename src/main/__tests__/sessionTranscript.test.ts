import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'

// omp/index.ts pulls in electron; the transcript reader only needs its two
// session lookups, so the module is stubbed wholesale.
vi.mock('../omp', () => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn()
}))

import { getSession, getSessionMessages } from '../omp'
import { readSessionTranscript } from '../sessionTranscript'

describe('readSessionTranscript (OMP_SESSION_TRANSCRIPT handler core)', () => {
  it('rejects invalid session ids with null and never touches the registry', async () => {
    for (const bad of [undefined, null, 42, {}, '', 'a'.repeat(513), 'bad\nid', 'id\x00x']) {
      await expect(readSessionTranscript(bad)).resolves.toBeNull()
    }
    expect(vi.mocked(getSession)).not.toHaveBeenCalled()
    expect(vi.mocked(getSessionMessages)).not.toHaveBeenCalled()
  })

  it('returns null for a session that is not live in Main', async () => {
    vi.mocked(getSession).mockReturnValue(undefined)
    await expect(readSessionTranscript('session-gone')).resolves.toBeNull()
    expect(vi.mocked(getSessionMessages)).not.toHaveBeenCalled()
  })

  it('maps a live session through the runtime transcript parser', async () => {
    const live: Session = { id: 'session-live', cwd: '/w', title: 't', createdAt: 1, status: 'idle' }
    vi.mocked(getSession).mockReturnValue(live)
    const messages = [
      { id: 'm1', role: 'user' as const, content: '分析今天的广告' },
      { id: 'm2', role: 'assistant' as const, content: '好的' }
    ]
    vi.mocked(getSessionMessages).mockResolvedValue(messages)

    await expect(readSessionTranscript('session-live')).resolves.toEqual(messages)
    expect(vi.mocked(getSessionMessages)).toHaveBeenCalledWith('session-live')
  })
})
