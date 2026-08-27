import { describe, it, expect } from 'vitest'
import { classifyRpcResponse, parseUnknownCommandError } from '../omp/OmpSession'

/** Parse helper: identity over `data.subagents` arrays for the roster tests. */
function parseRoster(data: unknown): string[] | null {
  const subagents = (data as { subagents?: unknown } | null)?.subagents
  return Array.isArray(subagents) ? (subagents as string[]) : null
}

describe('classifyRpcResponse — capability semantics', () => {
  it('success → success', () => {
    const outcome = classifyRpcResponse(
      { type: 'response', command: 'get_subagents', success: true, data: { subagents: ['a'] } },
      'get_subagents',
      parseRoster
    )
    expect(outcome.kind).toBe('success')
    expect((outcome as { data: string[] }).data).toEqual(['a'])
  })

  it('supported command + invalid child → command-error (still SUPPORTED, not unsupported)', () => {
    const outcome = classifyRpcResponse(
      { type: 'response', command: 'get_subagent_messages', success: false, error: 'Unknown subagent or session file unavailable: x' },
      'get_subagent_messages',
      () => null
    )
    expect(outcome.kind).toBe('command-error')
  })

  it('permission/state error → command-error (supported)', () => {
    const outcome = classifyRpcResponse(
      { type: 'response', command: 'get_subagents', success: false, error: 'Subagent event bus is unavailable' },
      'get_subagents',
      parseRoster
    )
    expect(outcome.kind).toBe('command-error')
  })

  it('unknown command → unsupported', () => {
    const outcome = classifyRpcResponse(
      { type: 'response', command: 'get_subagent_messages', success: false, error: 'Unknown command: get_subagent_messages' },
      'get_subagent_messages',
      () => null
    )
    expect(outcome.kind).toBe('unsupported')
  })

  it('timeout / no response → unknown (never unsupported)', () => {
    expect(classifyRpcResponse<string[]>(null, 'get_subagents', parseRoster).kind).toBe('unknown')
  })

  it('success:true with malformed data → unknown', () => {
    const outcome = classifyRpcResponse(
      { type: 'response', command: 'get_subagents', success: true, data: { not_subagents: true } },
      'get_subagents',
      parseRoster
    )
    expect(outcome.kind).toBe('unknown')
  })
})

describe('parseUnknownCommandError (strict)', () => {
  it('parses the official "Unknown command: X" format', () => {
    expect(parseUnknownCommandError('Unknown command: get_subagent_messages')).toBe('get_subagent_messages')
    expect(parseUnknownCommandError('Unknown command: negotiate_protocol')).toBe('negotiate_protocol')
  })

  it('rejects non-unknown-command errors (never guessed)', () => {
    expect(parseUnknownCommandError('Internal runtime error')).toBeNull()
    expect(parseUnknownCommandError('Unknown subagent or session file unavailable: x')).toBeNull()
    expect(parseUnknownCommandError(undefined)).toBeNull()
    expect(parseUnknownCommandError('Unknown command: with extra words')).toBeNull()
  })
})
