import { describe, it, expect } from 'vitest'
import type { SessionEvent, SubagentSnapshot, HistoricalAgentRecord } from '@shared/types'
import {
  emptyProjection,
  foldExecutionEvent,
  applyAgentRoster,
  applyHistoricalAgents,
  foldUserSteer,
  normalizeOmpAgentStatus,
  classifyToolCall,
  currentTurn
} from './execution'

function subagent(
  sessionId: string,
  patch: Partial<Extract<SessionEvent, { type: 'subagent' }>>
): SessionEvent {
  return {
    type: 'subagent',
    sessionId,
    id: 'a1',
    agent: 'explore',
    agentSource: 'bundled',
    status: 'running',
    // Real runtime lifecycle payloads always carry the child transcript (a
    // root/main-thread artifact carries neither this nor parentToolCallId).
    sessionFile: '/tmp/omp/sessions/child-a1.jsonl',
    ...patch
  }
}

const S = 'session-1'

describe('classifyToolCall (single classifier)', () => {
  it('maps tool names to the shared categories', () => {
    expect(classifyToolCall('read')).toBe('read')
    expect(classifyToolCall('grep')).toBe('search')
    expect(classifyToolCall('bash')).toBe('command')
    expect(classifyToolCall('edit')).toBe('edit')
    expect(classifyToolCall('subagent')).toBe('subagent')
    expect(classifyToolCall('some-extension-tool')).toBe('other')
  })
})

describe('normalizeOmpAgentStatus (exact)', () => {
  it('maps the AgentProgress status enum verbatim', () => {
    expect(normalizeOmpAgentStatus('pending')).toBe('pending')
    expect(normalizeOmpAgentStatus('running')).toBe('running')
    expect(normalizeOmpAgentStatus('completed')).toBe('completed')
    expect(normalizeOmpAgentStatus('failed')).toBe('failed')
    expect(normalizeOmpAgentStatus('aborted')).toBe('aborted')
  })

  it('never guesses unknown strings', () => {
    expect(normalizeOmpAgentStatus('parked')).toBe('unknown')
    expect(normalizeOmpAgentStatus('interrupted')).toBe('unknown')
    expect(normalizeOmpAgentStatus(undefined)).toBe('unknown')
  })
})

describe('multi-turn execution projection', () => {
  it('keeps turn 1 and turn 2 fully independent', () => {
    let p = emptyProjection(S)
    // Turn 1
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldExecutionEvent(p, { type: 'thinking', sessionId: S, delta: '...' }, 1)
    p = foldExecutionEvent(p, { type: 'tool_call', sessionId: S, tool: 'read', input: {} }, 2)
    p = foldExecutionEvent(p, { type: 'tool_call', sessionId: S, tool: 'bash', input: {} }, 3)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'idle', isTerminal: true }, 4)
    // Turn 2
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 5)
    p = foldExecutionEvent(p, { type: 'thinking', sessionId: S, delta: '...' }, 6)
    p = foldExecutionEvent(p, { type: 'tool_call', sessionId: S, tool: 'edit', input: {} }, 7)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'idle', isTerminal: true }, 8)

    expect(p.turnOrder).toEqual(['turn-1', 'turn-2'])
    expect(p.turns['turn-1'].tools).toMatchObject({ read: 1, command: 1 })
    expect(p.turns['turn-1'].trajectory.some((e) => e.kind === 'reasoning')).toBe(true)
    expect(p.turns['turn-2'].tools).toMatchObject({ edit: 1, read: 0, command: 0 })
    expect(p.turns['turn-2'].trajectory.some((e) => e.kind === 'reasoning')).toBe(true)
    expect(p.turns['turn-2'].startedAt).toBe(5)
  })

  it('does not end the turn when agent_end has isTerminal false', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'idle', isTerminal: false }, 1)
    expect(p.currentTurnId).toBe('turn-1')
    expect(p.turns['turn-1'].status).toBe('running')
  })
})

describe('agent graph (flat roster)', () => {
  it('handles out-of-order completion', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldExecutionEvent(p, subagent(S, { id: 'A', status: 'running' }), 1)
    p = foldExecutionEvent(p, subagent(S, { id: 'B', status: 'running' }), 2)
    p = foldExecutionEvent(p, subagent(S, { id: 'B', status: 'completed' }), 3)
    p = foldExecutionEvent(p, subagent(S, { id: 'A', status: 'completed' }), 4)
    expect(p.agents.A.status).toBe('completed')
    expect(p.agents.B.status).toBe('completed')
  })

  it('merges a roster snapshot then live events onto the same node', () => {
    let p = emptyProjection(S)
    const snapshot: SubagentSnapshot = {
      id: 'x',
      index: 0,
      agent: 'security',
      agentSource: 'bundled',
      status: 'running',
      task: 'Review auth',
      sessionFile: '/tmp/omp/sessions/child-x.jsonl',
      lastUpdate: 100
    }
    p = applyAgentRoster(p, [snapshot], 1)
    expect(p.agents.x).toMatchObject({ id: 'x', status: 'running', task: 'Review auth' })
    p = foldExecutionEvent(p, subagent(S, { id: 'x', status: 'completed' }), 2)
    expect(Object.values(p.agents).filter((n) => n.id === 'x')).toHaveLength(1)
    expect(p.agents.x.status).toBe('completed')
  })

  it('turn end leaves a running subagent running (detached subagent)', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldExecutionEvent(p, subagent(S, { id: 'X', status: 'running' }), 1)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'idle', isTerminal: true }, 2)

    expect(p.agents.X.status).toBe('running') // NOT unknown/completed
    // Later the runtime reports it completed — only then does it flip.
    p = foldExecutionEvent(p, subagent(S, { id: 'X', status: 'completed' }), 3)
    expect(p.agents.X.status).toBe('completed')
  })
})

describe('main-thread (root) entries never become subagents', () => {
  // Root-shaped artifact: no parentToolCallId, no child sessionFile. Oh My Pi's
  // subagent bus is built EXCLUSIVELY from spawned-children lifecycle events
  // (every `started` payload carries both signals; terminal children are
  // dropped from the live roster), so the root agent never appears — but if a
  // runtime ever reports one, it must not render as a "subagent".
  const rootArtifact: SubagentSnapshot = {
    id: 'main',
    index: 0,
    agent: 'main',
    agentSource: 'bundled',
    status: 'running',
    lastUpdate: 1
  }

  it('drops a roster snapshot that carries neither parentToolCallId nor sessionFile', () => {
    let p = emptyProjection(S)
    p = applyAgentRoster(p, [rootArtifact], 1)
    expect(p.agents).toEqual({})
  })

  it('keeps a real spawned child next to the filtered artifact', () => {
    let p = emptyProjection(S)
    p = applyAgentRoster(p, [
      rootArtifact,
      {
        id: 'child-1',
        index: 1,
        agent: 'explore',
        agentSource: 'bundled',
        status: 'running',
        parentToolCallId: 'tool-call-7',
        sessionFile: '/tmp/omp/sessions/child-1.jsonl',
        lastUpdate: 2
      }
    ], 3)
    expect(Object.keys(p.agents)).toEqual(['child-1'])
  })

  it('drops a live subagent event without a child transcript or parent tool call', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, subagent(S, { id: 'main', sessionFile: undefined }), 1)
    expect(p.agents).toEqual({})
  })

  it('a plain chat records trajectory facts but zero agents (panel renders nothing)', () => {
    // Fixture of the REAL session on disk (测试v0.9.0界面响应速度，请仅回复 OK):
    // its durable JSONL holds only the user prompt and the assistant reply —
    // no task/subagent activity — yet the old trajectory-only render guard
    // still showed the "subagent activity" panel.
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldExecutionEvent(p, { type: 'thinking', sessionId: S, delta: '...' }, 1)
    p = foldExecutionEvent(p, { type: 'message', sessionId: S, role: 'assistant', content: 'OK' }, 2)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'idle', isTerminal: true }, 3)
    expect(p.agents).toEqual({})
    expect(p.turns['turn-1'].trajectory.map((e) => e.kind)).toEqual(['reasoning', 'message'])
  })
})

describe('steer', () => {
  it('appends to the active turn without creating a new one', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, { type: 'status', sessionId: S, status: 'working' }, 0)
    p = foldUserSteer(p, 'Focus only on runtime layer')
    expect(p.turnOrder).toEqual(['turn-1'])
    expect(currentTurn(p)?.trajectory.some((e) => e.kind === 'steer')).toBe(true)
  })
})

describe('agent telemetry + sparse merge', () => {
  it('preserves resolvedModel/tokens/cost when a later sparse event only sets status', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(
      p,
      subagent(S, { id: 'x', status: 'running', resolvedModel: 'claude/x', tokens: 42000, cost: 0.05 }),
      1
    )
    p = foldExecutionEvent(p, subagent(S, { id: 'x', status: 'completed' }), 2)
    expect(p.agents.x.status).toBe('completed')
    expect(p.agents.x.resolvedModel).toBe('claude/x')
    expect(p.agents.x.tokens).toBe(42000)
    expect(p.agents.x.cost).toBe(0.05)
  })

  it('a sparse roster snapshot does not erase live telemetry', () => {
    let p = emptyProjection(S)
    p = foldExecutionEvent(p, subagent(S, { id: 'x', status: 'running', resolvedModel: 'claude/x', durationMs: 5000 }), 1)
    const snapshot: SubagentSnapshot = {
      id: 'x',
      index: 0,
      agent: 'explore',
      agentSource: 'bundled',
      status: 'running',
      sessionFile: '/tmp/omp/sessions/child-x.jsonl',
      lastUpdate: 2
    }
    p = applyAgentRoster(p, [snapshot], 2)
    expect(p.agents.x.resolvedModel).toBe('claude/x')
    expect(p.agents.x.durationMs).toBe(5000)
    expect(p.agents.x.status).toBe('running')
  })
})

describe('durable historical agents', () => {
  it('reconstructs a completed child that the live roster no longer reports', () => {
    let p = emptyProjection(S)
    const record: HistoricalAgentRecord = {
      id: 'hist-1',
      agent: 'explore',
      agentSource: 'bundled',
      status: 'completed',
      resolvedModel: 'openai/gpt-a',
      durationMs: 12000,
      tokens: 9000,
      resultSummary: 'Done'
    }
    p = applyHistoricalAgents(p, [record], 1)
    expect(p.agents['hist-1'].status).toBe('completed')
    expect(p.agents['hist-1'].resolvedModel).toBe('openai/gpt-a')
    expect(p.agents['hist-1'].durationMs).toBe(12000)
  })

  it('does not synthesize historical timestamps when durable history omits them', () => {
    let p = emptyProjection(S)
    p = applyHistoricalAgents(
      p,
      [{ id: 'hist-unknown-time', agent: 'explore', agentSource: 'bundled', status: 'unknown', durationMs: 12000 }],
      999
    )
    expect(p.agents['hist-unknown-time'].startedAt).toBeUndefined()
    expect(p.agents['hist-unknown-time'].endedAt).toBeUndefined()
  })

  it('live roster/events override history for status but keep historical telemetry', () => {
    let p = emptyProjection(S)
    p = applyHistoricalAgents(
      p,
      [{ id: 'a', agent: 'x', agentSource: 'bundled', status: 'completed', tokens: 100 }],
      1
    )
    // A live snapshot says the agent is now running again (revived) without tokens.
    p = applyAgentRoster(
      p,
      [
        {
          id: 'a',
          index: 0,
          agent: 'x',
          agentSource: 'bundled',
          status: 'running',
          sessionFile: '/tmp/omp/sessions/child-a.jsonl',
          lastUpdate: 2
        }
      ],
      2
    )
    expect(p.agents.a.status).toBe('running') // live wins for status
    expect(p.agents.a.tokens).toBe(100) // historical telemetry preserved
  })
})
