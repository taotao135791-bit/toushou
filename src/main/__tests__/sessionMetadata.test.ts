import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  reconstructSessionMetadata,
  reconstructHistoricalAgents,
  parseSessionEntries,
  resolveActivePath
} from '../sessionMetadata'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-gui-meta-'))
  n = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

let n = 0
function entry(type: string, parentId: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id: `e${n++}`, parentId, ...extra })
}

function writeSession(lines: string[]): string {
  const file = path.join(dir, 'session.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function writeChildSession(id: string, lines: Record<string, unknown>[]): void {
  const artifactsDir = path.join(dir, 'session')
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(path.join(artifactsDir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

describe('resolveActivePath', () => {
  it('walks leaf → root and reverses', () => {
    const lines = [
      entry('session', null),
      entry('message', 'e0'),
      entry('message', 'e0')
    ]
    const active = resolveActivePath(parseSessionEntries(lines.join('\n')))
    expect(active[0].id).toBe('e0')
    expect(active[active.length - 1].id).toBe('e2')
  })
})

describe('reconstructSessionMetadata (branch-aware)', () => {
  it('replays model_change / thinking_level_change per user prompt on the active path', async () => {
    const file = writeSession([
      entry('session', null),
      entry('model_change', 'e0', { model: 'openai/gpt-a' }),
      entry('thinking_level_change', 'e1', { thinkingLevel: 'high' }),
      entry('message', 'e2', { message: { role: 'user', content: 'prompt 1' } }),
      entry('model_change', 'e3', { model: 'openai/gpt-b' }),
      entry('message', 'e4', { message: { role: 'user', content: 'prompt 2' } }),
      entry('thinking_level_change', 'e5', { thinkingLevel: 'medium' }),
      entry('message', 'e6', { message: { role: 'user', content: 'prompt 3' } })
    ])
    await expect(reconstructSessionMetadata(file)).resolves.toEqual([
      { model: 'openai/gpt-a', thinking: 'high' },
      { model: 'openai/gpt-b', thinking: 'high' },
      { model: 'openai/gpt-b', thinking: 'medium' }
    ])
  })

  it('only applies default-role model changes to the parent turn', async () => {
    const file = writeSession([
      entry('session', null),
      entry('model_change', 'e0', { model: 'openai/gpt-a', role: 'default' }),
      entry('model_change', 'e1', { model: 'openai/gpt-smol', role: 'smol' }),
      entry('message', 'e2', { message: { role: 'user', content: 'prompt 1' } }),
      entry('model_change', 'e3', { model: 'openai/gpt-b', role: 'default' }),
      entry('message', 'e4', { message: { role: 'user', content: 'prompt 2' } })
    ])
    await expect(reconstructSessionMetadata(file)).resolves.toEqual([
      { model: 'openai/gpt-a', thinking: undefined },
      { model: 'openai/gpt-b', thinking: undefined }
    ])
  })

  it('ignores an abandoned branch after a rollback', async () => {
    // Linear: r0(session) → r1(model A) → r2(prompt 1) → r3(model B) → r4(prompt 2, abandoned)
    // Rollback to after prompt 1 (r2): r5(model C) → r6(prompt 3, active)
    const file = writeSession([
      JSON.stringify({ type: 'session', id: 'r0', parentId: null }),
      JSON.stringify({ type: 'model_change', id: 'r1', parentId: 'r0', model: 'openai/gpt-a' }),
      JSON.stringify({ type: 'message', id: 'r2', parentId: 'r1', message: { role: 'user', content: 'prompt 1' } }),
      JSON.stringify({ type: 'model_change', id: 'r3', parentId: 'r2', model: 'openai/gpt-b' }),
      JSON.stringify({ type: 'message', id: 'r4', parentId: 'r3', message: { role: 'user', content: 'prompt 2' } }),
      JSON.stringify({ type: 'model_change', id: 'r5', parentId: 'r2', model: 'openai/gpt-c' }),
      JSON.stringify({ type: 'message', id: 'r6', parentId: 'r5', message: { role: 'user', content: 'prompt 3' } })
    ])
    await expect(reconstructSessionMetadata(file)).resolves.toEqual([
      { model: 'openai/gpt-a', thinking: undefined },
      { model: 'openai/gpt-c', thinking: undefined }
    ])
  })

  it('returns [] for an unreadable file', async () => {
    await expect(reconstructSessionMetadata(path.join(dir, 'missing.jsonl'))).resolves.toEqual([])
  })
})

describe('reconstructHistoricalAgents', () => {
  it('reconstructs terminal children from upstream-shaped SingleResult records', async () => {
    // Mirrors OMP 17.2.12 `SingleResult` and `TaskToolDetails` from
    // packages/coding-agent/src/task/types.ts.
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', {
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: {
            results: [
              {
                index: 0,
                id: 'a1',
                agent: 'explore',
                agentSource: 'bundled',
                task: 'Inspect the repository',
                exitCode: 0,
                output: 'ok',
                stderr: '',
                truncated: false,
                durationMs: 12000,
                tokens: 9000,
                requests: 2,
                contextTokens: 4000,
                contextWindow: 128000,
                modelRole: 'default',
                resolvedModel: 'openai/gpt-a',
                usage: {
                  input: 7000,
                  output: 1500,
                  cacheRead: 0,
                  cacheWrite: 500,
                  totalTokens: 9000,
                  cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 }
                }
              },
              {
                index: 1,
                id: 'a2',
                agent: 'security',
                agentSource: 'bundled',
                task: 'Review the boundary',
                exitCode: 1,
                output: '',
                stderr: 'boom',
                truncated: false,
                durationMs: 3000,
                tokens: 100,
                requests: 1,
                error: 'boom'
              },
              {
                index: 2,
                id: 'a3',
                agent: 'tests',
                agentSource: 'bundled',
                task: 'Run the tests',
                exitCode: 1,
                output: '',
                stderr: '',
                truncated: false,
                durationMs: 800,
                tokens: 20,
                requests: 1,
                aborted: true,
                abortReason: 'user'
              }
            ],
            projectAgentsDir: null,
            totalDurationMs: 15800
          }
        }
      })
    ])
    const agents = await reconstructHistoricalAgents(file)
    expect(agents.map((a) => [a.id, a.status])).toEqual([
      ['a1', 'completed'],
      ['a2', 'failed'],
      ['a3', 'aborted']
    ])
    expect(agents[0].resolvedModel).toBe('openai/gpt-a')
    expect(agents[0].durationMs).toBe(12000)
    expect(agents[0].tokens).toBe(9000)
    expect(agents[0].cost).toBe(0.02)
  })

  it('ignores non-task tool results and returns [] when none', async () => {
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', { message: { role: 'toolResult', toolName: 'bash', details: { results: [{ id: 'x' }] } } })
    ])
    await expect(reconstructHistoricalAgents(file)).resolves.toEqual([])
  })

  it('does not fabricate timestamps when an upstream result only carries duration', async () => {
    // SingleResult in OMP 17.2.12 has durationMs but no startedAt/endedAt.
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', {
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: {
            projectAgentsDir: null,
            results: [{ index: 0, id: 'a1', agent: 'explore', agentSource: 'bundled', task: 'Inspect', exitCode: 0, output: 'ok', stderr: '', truncated: false, durationMs: 18400, tokens: 1, requests: 1 }],
            totalDurationMs: 18400
          }
        }
      })
    ])
    const [agent] = await reconstructHistoricalAgents(file)
    expect(agent.durationMs).toBe(18400)
    expect(agent.startedAt).toBeUndefined()
    expect(agent.endedAt).toBeUndefined()
  })

  it('rebuilds a background task from progress, async-result, and its child artifact', async () => {
    // The initial task result is the real background shape: results is empty,
    // progress carries identity/telemetry, and async carries the job id.
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', {
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 10,
            progress: [
              {
                index: 0,
                id: 'bg1',
                agent: 'security',
                agentSource: 'bundled',
                status: 'running',
                task: 'Review workspace grants',
                assignment: 'Review workspace grants',
                recentTools: [],
                recentOutput: [],
                toolCount: 0,
                requests: 0,
                tokens: 0,
                cost: 0,
                durationMs: 0,
                modelRole: 'task',
                resolvedModel: 'openai/gpt-a'
              }
            ],
            async: { state: 'running', jobId: 'bg1', type: 'task' }
          }
        }
      }),
      entry('message', 'e1', {
        message: {
          role: 'custom',
          customType: 'async-result',
          content: 'background result delivered',
          display: true,
          attribution: 'agent',
          details: { jobs: [{ jobId: 'bg1', type: 'task', label: 'security', durationMs: 5000 }] },
          timestamp: 1729159218400
        }
      })
    ])
    // Mirrors OMP 17.2.12 `session_init` plus durable assistant message fields.
    writeChildSession('bg1', [
      {
        type: 'session_init',
        id: 'c0',
        parentId: null,
        timestamp: '2026-08-18T10:00:00.000Z',
        systemPrompt: 'system',
        task: 'Review workspace grants',
        tools: ['read'],
        agent: 'security',
        modelRole: 'task',
        resolvedModel: 'openai/gpt-a'
      },
      {
        type: 'message',
        id: 'c1',
        parentId: 'c0',
        timestamp: '2026-08-18T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No issues' }],
          stopReason: 'stop',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 10,
            totalTokens: 170,
            cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 }
          }
        }
      }
    ])
    const [agent] = await reconstructHistoricalAgents(file)
    expect(agent.id).toBe('bg1')
    expect(agent.status).toBe('completed')
    expect(agent.durationMs).toBe(5000)
    expect(agent.tokens).toBe(160)
    expect(agent.requests).toBe(1)
    expect(agent.contextTokens).toBe(170)
    expect(agent.cost).toBe(0.02)
    expect(agent.modelRole).toBe('task')
    expect(agent.startedAt).toBe(Date.parse('2026-08-18T10:00:00.000Z'))
    expect(agent.endedAt).toBe(Date.parse('2026-08-18T10:00:05.000Z'))
    expect(agent.resultSummary).toBe('No issues')
  })

  it('reconstructs multiple background jobs from one async-result batch without fake terminal states', async () => {
    // Mirrors OMP 17.2.12 `buildAsyncResultBatchMessage` details.jobs shape.
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', {
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 20,
            progress: [
              { index: 0, id: 'bg1', agent: 'security', agentSource: 'bundled', status: 'running', task: 'A', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 },
              { index: 1, id: 'bg2', agent: 'review', agentSource: 'bundled', status: 'running', task: 'B', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 }
            ],
            async: { state: 'running', jobId: 'bg1', type: 'task' }
          }
        }
      }),
      entry('message', 'e1', {
        message: {
          role: 'custom',
          customType: 'async-result',
          details: {
            jobs: [
              { jobId: 'bg1', type: 'task', label: 'security', durationMs: 1000 },
              { jobId: 'bg2', type: 'task', label: 'review', durationMs: 2000 }
            ]
          }
        }
      })
    ])
    const agents = await reconstructHistoricalAgents(file)
    expect(agents.map((a) => [a.id, a.status, a.durationMs])).toEqual([
      ['bg1', 'unknown', 1000],
      ['bg2', 'unknown', 2000]
    ])
  })

  it('keeps a spawned child unknown when no durable terminal signal exists', async () => {
    const file = writeSession([
      entry('session', null),
      entry('message', 'e0', {
        message: {
          role: 'toolResult',
          toolName: 'task',
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 0,
            progress: [
              { index: 0, id: 'bg1', agent: 'security', agentSource: 'bundled', status: 'running', task: 'Inspect', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 }
            ],
            async: { state: 'running', jobId: 'bg1', type: 'task' }
          }
        }
      })
    ])
    const [agent] = await reconstructHistoricalAgents(file)
    expect(agent.status).toBe('unknown')
    expect(agent.startedAt).toBeUndefined()
    expect(agent.endedAt).toBeUndefined()
    expect(agent.durationMs).toBeUndefined()
  })
})
