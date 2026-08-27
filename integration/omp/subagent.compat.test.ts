import { describe, it, expect, beforeAll } from 'vitest'
import { ChildProcess } from 'node:child_process'
import { OmpSession, OmpProcessLike } from '../../src/main/omp/OmpSession'
import { SessionEvent } from '../../src/shared/types'
import { createIsolatedOmpEnvironment, binaryAvailable, requireBinary, IsolatedRuntime } from './isolated-runtime'

/**
 * Subagent bridge compatibility — the GUI's own OmpSession driving the real
 * `omp` binary through the subagent RPC surface.
 *
 * HERMETIC + CREDENTIAL-FREE: every spawn runs in a fresh temp agent dir with
 * credentials stripped and a zero-auth bootstrap placeholder, so no model
 * inference happens (ZERO tokens) and the real config/auth is never touched.
 * Creating a real subagent requires model inference, so this suite only
 * verifies the RPC CONTRACT framing (subscription + roster + child-message
 * errors) — not live agent spawning, which belongs to test:omp:live.
 */

const OMP_BIN = process.env.OMP_BIN || 'omp'
const BOOTSTRAP_KEY = 'omp-gui-bootstrap-placeholder'

function isolatedRpc(): IsolatedRuntime {
  const iso = createIsolatedOmpEnvironment()
  iso.env.DEEPSEEK_API_KEY = BOOTSTRAP_KEY
  return iso
}

interface LiveSession {
  session: OmpSession
  proc: ChildProcess
  iso: IsolatedRuntime
  events: SessionEvent[]
  stderrTail: () => string
}

function startSession(iso = isolatedRpc()): LiveSession {
  const proc = iso.spawnRpc(OMP_BIN, [])
  const events: SessionEvent[] = []
  let stderr = ''
  proc.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-4000)
  })
  const session = new OmpSession(
    { id: 'it', cwd: iso.agentDir, title: 'it', createdAt: Date.now(), status: 'idle' },
    proc as unknown as OmpProcessLike,
    { label: OMP_BIN, onEvent: (e) => events.push(e) }
  )
  return { session, proc, iso, events, stderrTail: () => stderr }
}

function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

function diedEarly(live: LiveSession): boolean {
  return live.session.handshakeOutcome === null
}

describe('current omp — subagent RPC bridge', () => {
  let available = false
  beforeAll(() => {
    available = binaryAvailable(OMP_BIN)
    if (!available) requireBinary(OMP_BIN)
    else console.log(`[test:omp] '${OMP_BIN}' found — running subagent bridge suite`)
  })

  it('set_subagent_subscription to progress is accepted (framing)', async () => {
    if (!available) return
    const live = startSession()
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      const res = await live.session.query({ type: 'set_subagent_subscription', level: 'progress' }, 10_000)
      expect(res?.success).toBe(true)
      expect((res?.data as { level?: string }).level).toBe('progress')
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('get_subagents hydrates an empty roster (no prompt sent)', async () => {
    if (!available) return
    const live = startSession()
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      const sub = await live.session.setSubagentSubscription('progress')
      expect(sub.kind).toBe('success')
      const roster = await live.session.getSubagents()
      expect(roster.kind).toBe('success')
      if (roster.kind === 'success') expect(roster.data).toHaveLength(0)
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('get_subagent_messages for an unknown id → command-error (SUPPORTED, not unsupported)', async () => {
    if (!available) return
    const live = startSession()
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      const result = await live.session.getSubagentMessages({ subagentId: 'does-not-exist' })
      // The runtime ANSWERED (success:false) → the command exists. This is the
      // P0 regression: an operation failure must NOT read as "unsupported".
      expect(result.kind).toBe('command-error')
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('subscription level off/events round-trips without error', async () => {
    if (!available) return
    const live = startSession()
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      expect((await live.session.setSubagentSubscription('off')).kind).toBe('success')
      const res = await live.session.query({ type: 'set_subagent_subscription', level: 'events' }, 10_000)
      expect(res?.success).toBe(true)
      expect((res?.data as { level?: string }).level).toBe('events')
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })
})
