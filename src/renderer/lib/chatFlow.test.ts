import { describe, expect, it } from 'vitest'
import type { MessageLike } from '../store'
import { projectChatTurns } from './chatFlow'

const msg = (id: string, role: MessageLike['role'], content = ''): MessageLike => ({ id, role, content })
const tool = (id: string, isError = false): MessageLike => ({ ...msg(id, 'assistant'), toolCall: { tool: 'synthetic_tool', input: {}, output: '{}', isError } })

describe('chat turn presentation', () => {
  it('keeps interleaved commentary and all tools in one inspectable process before the answer', () => {
    const input = [msg('u', 'user', 'Synthetic report'), msg('intro', 'assistant', 'Checking'), tool('a'), msg('dot', 'assistant', '.'), tool('b'), msg('answer', 'assistant', 'Report ready')]
    const turns = projectChatTurns(input)
    expect(turns).toHaveLength(1)
    expect(turns[0].nodes.map(node => node.kind)).toEqual(['message', 'process', 'message'])
    const process = turns[0].nodes[1]
    expect(process.kind === 'process' && process.entries.map(entry => entry.message.id)).toEqual(['intro', 'a', 'dot', 'b'])
    expect(turns[0].entries.map(entry => entry.message)).toEqual(input)
    expect(turns[0].entries.map(entry => entry.index)).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('does not hide system errors or steering, split turn ownership, or offer board actions for process fragments', () => {
    const turns = projectChatTurns([msg('u', 'user', 'Report'), tool('a', true), msg('error', 'system', 'Synthetic failure'), { ...msg('steer', 'user', 'Keep going'), kind: 'steer' }, msg('dot', 'assistant', '.'), tool('b')])
    expect(turns).toHaveLength(1)
    expect(turns[0].nodes.filter(node => node.kind === 'message').map(node => node.kind === 'message' && node.entry.message.id)).toEqual(['u', 'error', 'steer'])
    expect(turns[0].nodes.at(-1)?.kind).toBe('process')
  })
  it('preserves normal chat and treats a short final response as real content', () => {
    const input = [msg('u', 'user', 'Hi'), msg('a', 'assistant', 'OK'), msg('u2', 'user', 'Check'), tool('t'), msg('a2', 'assistant', '✓')]
    const turns = projectChatTurns(input)
    expect(turns.map(turn => turn.ownerIndex)).toEqual([0, 2])
    expect(turns[0].nodes.every(node => node.kind === 'message')).toBe(true)
    const final = turns[1].nodes.at(-1)
    expect(final?.kind === 'message' && final.showBoardAction).toBe(true)
  })
  it('keeps leading restored records, back-to-back prompts and thinking-only fragments', () => {
    const thinking = { ...msg('thinking', 'assistant'), thinking: 'Synthetic reasoning' }
    const turns = projectChatTurns([tool('restored'), msg('u', 'user'), msg('u2', 'user'), thinking, tool('a')])
    expect(turns.map(turn => turn.ownerIndex)).toEqual([null, 1, 2])
    expect(turns.flatMap(turn => turn.entries).map(entry => entry.index)).toEqual([0, 1, 2, 3, 4])
    expect(turns[2].nodes.at(-1)?.kind).toBe('process')
  })
  it('keeps historical turns stable during streaming and invalidates the actual changed record', () => {
    const history = Array.from({ length: 200 }, (_, index) => [msg(`u${index}`, 'user', 'Synthetic prompt'), tool(`t${index}`), msg(`a${index}`, 'assistant', 'Synthetic response')]).flat()
    const records = [...history, msg('live-user', 'user'), tool('live-tool'), msg('live-answer', 'assistant', 'A')]
    const first = projectChatTurns(records)
    const second = projectChatTurns([...records.slice(0, -1), { ...records.at(-1)!, content: 'AB' }], first)
    first.slice(0, -1).forEach((turn, index) => expect(second[index]).toBe(turn))
    expect(second.at(-1)).not.toBe(first.at(-1))
    const changed = [...records]
    changed[1] = { ...changed[1], toolCall: { ...changed[1].toolCall!, isError: true } }
    const third = projectChatTurns(changed, second)
    expect(third[0]).not.toBe(second[0])
    expect(third[1]).toBe(second[1])
  })
})
