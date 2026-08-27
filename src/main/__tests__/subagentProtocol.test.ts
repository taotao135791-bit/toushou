import { describe, it, expect } from 'vitest'
import { normalizeRpcFrame } from '../omp/OmpProtocol'

describe('subagent RPC normalization (real 17.2.12 contract)', () => {
  it('maps a started lifecycle to a running subagent event', () => {
    const result = normalizeRpcFrame(
      {
        type: 'subagent_lifecycle',
        payload: {
          id: 'agent-1',
          agent: 'security-review',
          agentSource: 'bundled',
          description: 'Review auth',
          status: 'started',
          sessionFile: '/tmp/agent-1.jsonl',
          parentToolCallId: 'tool-9',
          index: 0,
          detached: true
        }
      },
      'session-1'
    )
    expect(result.kind).toBe('event')
    if (result.kind !== 'event') throw new Error('unreachable')
    expect(result.event).toEqual({
      type: 'subagent',
      sessionId: 'session-1',
      id: 'agent-1',
      agent: 'security-review',
      agentSource: 'bundled',
      description: 'Review auth',
      status: 'running',
      phase: 'started',
      sessionFile: '/tmp/agent-1.jsonl',
      parentToolCallId: 'tool-9',
      index: 0,
      detached: true
    })
  })

  it('keeps terminal lifecycle statuses verbatim (completed/failed/aborted)', () => {
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      const result = normalizeRpcFrame(
        { type: 'subagent_lifecycle', payload: { id: 'x', agent: 'a', agentSource: 'bundled', status } },
        'session-1'
      )
      expect(result.kind).toBe('event')
      if (result.kind !== 'event') throw new Error('unreachable')
      expect(result.event).toMatchObject({ type: 'subagent', status, phase: status })
    }
  })

  it('maps subagent_progress onto the same subagent event with aggregated facts', () => {
    const result = normalizeRpcFrame(
      {
        type: 'subagent_progress',
        payload: {
          index: 0,
          agent: 'explore',
          agentSource: 'bundled',
          task: 'Read the repo',
          assignment: 'architecture',
          sessionFile: '/tmp/explore.jsonl',
          progress: {
            id: 'agent-2',
            agent: 'explore',
            agentSource: 'bundled',
            status: 'running',
            task: 'Read the repo',
            currentTool: 'read',
            lastIntent: 'Reading files',
            toolCount: 7
          }
        }
      },
      'session-1'
    )
    expect(result.kind).toBe('event')
    if (result.kind !== 'event') throw new Error('unreachable')
    expect(result.event).toMatchObject({
      type: 'subagent',
      id: 'agent-2',
      status: 'running',
      task: 'Read the repo',
      currentTool: 'read',
      lastIntent: 'Reading files',
      toolCount: 7
    })
  })

  it('drops a lifecycle event with an unknown status (never guesses)', () => {
    const result = normalizeRpcFrame(
      { type: 'subagent_lifecycle', payload: { id: 'x', agent: 'a', agentSource: 'bundled', status: 'weird' } },
      'session-1'
    )
    expect(result.kind).toBe('none')
  })

  it('ignores subagent_event (raw child stream — never projected)', () => {
    const result = normalizeRpcFrame(
      { type: 'subagent_event', payload: { id: 'x', event: { type: 'message' } } },
      'session-1'
    )
    expect(result.kind).toBe('none')
  })
})
