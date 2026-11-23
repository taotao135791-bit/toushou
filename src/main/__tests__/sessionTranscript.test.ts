import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'

// omp/index.ts pulls in electron; the transcript reader only needs its two
// session lookups, so the module is stubbed wholesale.
vi.mock('../omp', () => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn()
}))

import { getSession, getSessionMessages } from '../omp'
import { readSessionFileTranscript, readSessionTranscript } from '../sessionTranscript'

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

describe('readSessionFileTranscript (instant history preview)', () => {
  it('maps durable message entries through the agent mapper, skipping non-message records', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'peek-'))
    const file = path.join(dir, 'session.jsonl')
    const lines = [
      JSON.stringify({ type: 'title', v: 1, title: 'Peek me' }),
      JSON.stringify({ type: 'session', version: 3, id: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: 'D:/w' }),
      JSON.stringify({ type: 'model_change', id: 'm1', model: 'x' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '帮我看消耗' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'toushou_tiktok_status', arguments: {} }] } }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'toushou_tiktok_status', content: [{ type: 'text', text: 'ok' }] } }),
      'not json at all',
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '结论。' }] } })
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    const messages = await readSessionFileTranscript(file)
    expect(messages).not.toBeNull()
    // The canonical mapper folds a tool-call turn and its trailing text the
    // same way the live resume path does — exact grouping is its semantics.
    const flat = messages!.map((m) => `${m.role}:${m.content}`).join('\n')
    expect(flat).toContain('user:帮我看消耗')
    expect(messages!.some((m) => m.toolCall?.tool === 'toushou_tiktok_status')).toBe(true)
    expect(flat).toContain('结论。')
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for unreadable or message-less files', async () => {
    await expect(readSessionFileTranscript('D:/definitely/not/here.jsonl')).resolves.toBeNull()
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const dir = mkdtempSync(path.join(tmpdir(), 'peek-empty-'))
    const file = path.join(dir, 'empty.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'u2', timestamp: '2026-01-01T00:00:00.000Z', cwd: 'D:/w' }) + '\n', 'utf8')
    await expect(readSessionFileTranscript(file)).resolves.toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
