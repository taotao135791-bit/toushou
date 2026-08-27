import { describe, expect, it } from 'vitest'
import { applyToolResult, ToolCallMessage, ToolResultEvent } from '../lib/toolCalls'

let seq = 0
function call(tool: string, input: unknown, id?: string): ToolCallMessage {
  return { id: `m${++seq}`, role: 'assistant', content: '', toolCall: { id, tool, input } }
}

function result(tool: string, output: unknown, id?: string, isError = false): ToolResultEvent {
  return { type: 'tool_result', sessionId: 's1', id, tool, output, isError }
}

describe('applyToolResult', () => {
  it('pairs out-of-order results with their own call by toolCallId', () => {
    // bash A starts, bash B starts, B finishes first, A finishes last.
    const a = call('bash', { command: 'sleep 2' }, 'call-a')
    const b = call('bash', { command: 'echo hi' }, 'call-b')
    let list = applyToolResult([a, b], result('bash', 'hi\n', 'call-b'))
    list = applyToolResult(list, result('bash', 'done\n', 'call-a'))
    expect(list[0].toolCall?.output).toBe('done\n')
    expect(list[1].toolCall?.output).toBe('hi\n')
    // Immutable: the original cards were not mutated in place.
    expect(a.toolCall?.output).toBeUndefined()
    expect(b.toolCall?.output).toBeUndefined()
  })

  it('matches by id even when a same-name call is more recent', () => {
    // Name+recency would land A's result on B — the id must win.
    const a = call('bash', { command: 'a' }, 'id-a')
    const b = call('bash', { command: 'b' }, 'id-b')
    const list = applyToolResult([a, b], result('bash', 'out-a', 'id-a'))
    expect(list[0].toolCall?.output).toBe('out-a')
    expect(list[1].toolCall?.output).toBeUndefined()
  })

  it('legacy fallback: without ids, merges into the most recent pending call of the same tool', () => {
    const a = call('bash', { command: 'a' })
    const b = call('bash', { command: 'b' })
    let list = applyToolResult([a, b], result('bash', 'first'))
    expect(list[0].toolCall?.output).toBeUndefined()
    expect(list[1].toolCall?.output).toBe('first')
    // B is resolved now — the next id-less result falls to A.
    list = applyToolResult(list, result('bash', 'second'))
    expect(list[0].toolCall?.output).toBe('second')
  })

  it('appends an orphan card when no call matches', () => {
    const a = call('read', { path: 'x' }, 'id-r')
    const list = applyToolResult([a], result('write', 'written', 'id-unknown', true))
    expect(list).toHaveLength(2)
    expect(list[0].toolCall?.output).toBeUndefined()
    expect(list[1].toolCall).toMatchObject({
      id: 'id-unknown',
      tool: 'write',
      input: undefined,
      output: 'written',
      isError: true
    })
  })
})
