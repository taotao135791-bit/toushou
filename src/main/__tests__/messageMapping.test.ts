import { describe, it, expect } from 'vitest'
import { AgentContentBlock, AgentMessage, mapAgentMessages } from '../messageMapping'

function user(text: string | string[]): AgentMessage {
  const content = Array.isArray(text)
    ? text.map((t) => ({ type: 'text' as const, text: t }))
    : [{ type: 'text' as const, text }]
  return { role: 'user', content }
}

function steeredUser(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text' as const, text }], steering: true }
}

function assistant(...blocks: AgentContentBlock[]): AgentMessage {
  return { role: 'assistant', content: blocks }
}

function textBlock(text: string) {
  return { type: 'text' as const, text }
}

function toolCallBlock(id: string, name: string, args: unknown) {
  return { type: 'toolCall' as const, id, name, arguments: args }
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    isError,
    content: [{ type: 'text', text }]
  }
}

describe('mapAgentMessages', () => {
  it('returns [] for empty input', () => {
    expect(mapAgentMessages([])).toEqual([])
  })

  it('maps a user message, joining multiple text blocks', () => {
    const out = mapAgentMessages([user(['hello', 'world'])])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('hello\nworld')
    expect(out[0].id).toBeTruthy()
    expect(out[0].toolCall).toBeUndefined()
  })

  it('maps thinking blocks into the assistant message thinking field', () => {
    const out = mapAgentMessages([
      assistant({ type: 'thinking', thinking: 'hmm' }, textBlock('answer'))
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'assistant', content: 'answer', thinking: 'hmm' })
  })

  it('joins multiple thinking blocks with newlines', () => {
    const out = mapAgentMessages([
      assistant(
        { type: 'thinking', thinking: 'first' },
        { type: 'thinking', thinking: 'second' },
        textBlock('answer')
      )
    ])
    expect(out).toHaveLength(1)
    expect(out[0].thinking).toBe('first\nsecond')
  })

  it('attaches a thinking-only message before a tool card', () => {
    const out = mapAgentMessages([
      assistant({ type: 'thinking', thinking: 'let me check' }, toolCallBlock('c1', 'read', { path: 'x' }))
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'assistant', content: '', thinking: 'let me check' })
    expect(out[1].toolCall).toBeDefined()
  })

  it('merges consecutive assistant text blocks into one message', () => {
    const out = mapAgentMessages([
      assistant(textBlock('part one')),
      assistant({ type: 'thinking', thinking: '...' }, textBlock('part two'))
    ])
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('part one\n\npart two')
    expect(out[0].thinking).toBe('...')
  })

  it('keeps user and assistant messages in order', () => {
    const out = mapAgentMessages([user('q1'), assistant(textBlock('a1')), user('q2'), assistant(textBlock('a2'))])
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ['user', 'q1'],
      ['assistant', 'a1'],
      ['user', 'q2'],
      ['assistant', 'a2']
    ])
  })

  it('merges a toolResult into its toolCall card by toolCallId', () => {
    const out = mapAgentMessages([
      user('list files'),
      assistant(textBlock('let me check'), toolCallBlock('call-1', 'bash', { command: 'ls' })),
      toolResult('call-1', 'bash', 'file-a\nfile-b')
    ])
    expect(out).toHaveLength(3)
    expect(out[1].content).toBe('let me check')
    const toolMsg = out[2]
    expect(toolMsg.role).toBe('assistant')
    expect(toolMsg.content).toBe('')
    expect(toolMsg.toolCall).toEqual({
      tool: 'bash',
      input: { command: 'ls' },
      output: 'file-a\nfile-b',
      isError: false
    })
  })

  it('starts a new assistant text message after a tool card', () => {
    const out = mapAgentMessages([
      assistant(textBlock('before'), toolCallBlock('c1', 'read', { path: 'x' })),
      toolResult('c1', 'read', 'data'),
      assistant(textBlock('after'))
    ])
    expect(out.map((m) => m.content)).toEqual(['before', '', 'after'])
    expect(out[2].toolCall).toBeUndefined()
  })

  it('marks error results with isError', () => {
    const out = mapAgentMessages([
      assistant(toolCallBlock('c1', 'bash', { command: 'rm' })),
      toolResult('c1', 'bash', 'permission denied', true)
    ])
    expect(out[0].toolCall?.isError).toBe(true)
    expect(out[0].toolCall?.output).toBe('permission denied')
  })

  it('keeps an orphan toolResult as a card without input (store fallback shape)', () => {
    const out = mapAgentMessages([toolResult('missing', 'bash', 'out')])
    expect(out).toHaveLength(1)
    expect(out[0].toolCall).toEqual({ tool: 'bash', input: undefined, output: 'out', isError: false })
  })

  it('matches results to the right call when several are pending', () => {
    const out = mapAgentMessages([
      assistant(toolCallBlock('c1', 'read', { path: 'a' }), toolCallBlock('c2', 'read', { path: 'b' })),
      toolResult('c2', 'read', 'B'),
      toolResult('c1', 'read', 'A')
    ])
    expect(out[0].toolCall?.output).toBe('A')
    expect(out[1].toolCall?.output).toBe('B')
  })

  it('skips empty user/assistant content and unknown roles', () => {
    const out = mapAgentMessages([
      user(''),
      assistant(textBlock('   ')),
      { role: 'custom', content: 'hidden' },
      user('real')
    ])
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('real')
  })

  it('supports plain-string user content', () => {
    const out = mapAgentMessages([{ role: 'user', content: 'plain' }])
    expect(out[0].content).toBe('plain')
  })

  it('generates unique message ids', () => {
    const out = mapAgentMessages([user('a'), assistant(textBlock('b')), user('c')])
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length)
  })

  it('tags a steered user message with kind "steer" (not a new prompt)', () => {
    const out = mapAgentMessages([steeredUser('Focus on the runtime layer')])
    expect(out[0].kind).toBe('steer')
  })

  it('tags a normal user message with kind "prompt"', () => {
    const out = mapAgentMessages([user('hello')])
    expect(out[0].kind).toBe('prompt')
  })
})
