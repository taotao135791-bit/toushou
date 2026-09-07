import { describe, expect, it } from 'vitest'
import { mergeTranscriptBackfill } from './transcriptMerge'

type Row = { id: string; role: 'user' | 'assistant' | 'system'; content: string; toolCall?: { tool: string } }

const user = (id: string, content: string): Row => ({ id, role: 'user', content })
const assistant = (id: string, content: string): Row => ({ id, role: 'assistant', content })
const system = (id: string, content: string): Row => ({ id, role: 'system', content })
const tool = (id: string, name: string): Row => ({ id, role: 'assistant', content: '', toolCall: { tool: name } })

describe('mergeTranscriptBackfill', () => {
  it('replaces an empty store with the durable transcript and keeps rows when the fetch is empty', () => {
    const fetched = [user('u1', 'hi'), assistant('a1', 'hello')]
    expect(mergeTranscriptBackfill(fetched, [])).toEqual(fetched)
    const current = [user('u1', 'hi')]
    expect(mergeTranscriptBackfill([], current)).toEqual(current)
  })

  it('prepends durable history the store never streamed (renderer attached late)', () => {
    const fetched = [user('h1', '旧问题'), assistant('h2', '旧回答'), user('u1', 'q1'), assistant('a1', 'answer 1')]
    const current = [user('u1', 'q1'), assistant('a1', 'answer 1')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual([...fetched.slice(0, 2), ...current])
  })

  it('keeps streamed rows that landed after the snapshot without duplicating overlap', () => {
    const fetched = [user('u1', 'q1'), assistant('a1', 'answer 1')]
    const current = [user('u1', 'q1'), assistant('a1', 'answer 1'), user('u2', 'q2'), assistant('a2', 'working…')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual(current)
  })

  it('keeps the streamed in-flight tail so later deltas self-heal it', () => {
    const fetched = [user('u1', 'q1'), assistant('a1', '完整的回答内容（快照）')]
    const current = [user('u1', 'q1'), assistant('a1', '完整的回答')]
    // The streamed copy is kept: deltas that arrive after the backfill append
    // to it, so replacing it with the snapshot would carve a gap instead.
    expect(mergeTranscriptBackfill(fetched, current)).toEqual(current)
  })

  it('tolerates renderer-only system rows between durable messages', () => {
    const fetched = [user('u1', 'q1'), assistant('a1', 'done')]
    const current = [user('u1', 'q1'), system('s1', 'Error: transient'), assistant('a1', 'done')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual(current)
  })

  it('matches tool cards by tool name', () => {
    const fetched = [user('u1', 'q1'), tool('a1', 'read_file'), assistant('a2', 'done')]
    const current = [user('u1', 'q1'), tool('a1', 'read_file'), assistant('a2', 'done')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual(current)
  })

  it('keeps the streamed tail fresh when it outgrew the snapshot', () => {
    const fetched = [user('u1', 'q1'), assistant('a1', 'part')]
    const current = [user('u1', 'q1'), assistant('a1', 'partial answer, still streaming')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual(current)
  })

  it('never drops content when nothing aligns (worst case: durable prefix + streamed rows)', () => {
    const fetched = [user('u1', 'q1'), assistant('a1', 'durable answer')]
    const current = [user('u9', 'different'), assistant('a9', 'other')]
    expect(mergeTranscriptBackfill(fetched, current)).toEqual([...fetched, ...current])
  })
})
