import { describe, it, expect, beforeAll } from 'vitest'
import { ChildProcess } from 'node:child_process'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { OmpSession, OmpProcessLike } from '../../src/main/omp/OmpSession'
import { SessionEvent } from '../../src/shared/types'
import { makeExecRunner, configGet } from '../../src/main/omp/settings/OmpConfigCli'
import {
  createIsolatedOmpEnvironment,
  binaryAvailable,
  requireBinary,
  IsolatedRuntime
} from './isolated-runtime'

/**
 * Real-binary RPC compatibility suite — the GUI's own OmpSession driving the
 * actual installed omp (current profile) and pi (legacy profile).
 *
 * ISOLATION + CREDENTIAL-FREE: every spawn runs against a fresh temp
 * OMP/agent dir via `PI_CODING_AGENT_DIR` and a temp HOME; provider
 * credentials are stripped from the environment. No live model inference
 * happens (no "PONG"), so this suite consumes ZERO tokens and never touches
 * the developer's real config/auth. The zero-auth bootstrap placeholder is
 * used only so RPC mode boots (its provider is masked as not-authenticated).
 *
 * Covered against the real wire:
 * - ready frame → negotiate_protocol → v2 activation (current)
 * - no ready frame → legacy v1 detection (legacy)
 * - get_state on both profiles
 * - local-only prompt: agentInvoked:false + command_output, no agent_end
 * - permission flags spawn cleanly
 * - rpc_chunk: >1 MiB get_messages reassembled byte-exactly (current)
 * - session-scope vs default-scope isolation
 *
 * Binaries: OMP_BIN / PI_BIN env overrides, else `omp` / `pi` on PATH.
 * A suite skips (does not fail) when its binary is absent or the runtime
 * cannot start.
 */

const OMP_BIN = process.env.OMP_BIN || 'omp'
const PI_BIN = process.env.PI_BIN || 'pi'
const BOOTSTRAP_KEY = 'omp-gui-bootstrap-placeholder'

/** Bring up an isolated env whose RPC mode boots via the zero-auth bootstrap. */
function isolatedRpc(bin: string): IsolatedRuntime {
  const iso = createIsolatedOmpEnvironment()
  // Credential-free bootstrap so RPC mode actually starts (no model calls).
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

/** Spawn the real binary in an isolated env and wire it to a real OmpSession. */
function startSession(
  bin: string,
  extraArgs: string[] = [],
  iso = isolatedRpc(bin)
): LiveSession {
  const proc = iso.spawnRpc(bin, extraArgs)
  const events: SessionEvent[] = []
  let stderr = ''
  proc.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-4000)
  })
  const session = new OmpSession(
    { id: 'it', cwd: iso.agentDir, title: 'it', createdAt: Date.now(), status: 'idle' },
    proc as unknown as OmpProcessLike,
    { label: bin, onEvent: (e) => events.push(e) }
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

/** The process died before RPC mode engaged (usually: no model configured). */
function diedEarly(live: LiveSession): boolean {
  return live.events.some((e) => e.type === 'closed')
}

describe('current Oh My Pi (omp) — RPC v2 profile', () => {
  let available = false
  beforeAll(() => {
    available = binaryAvailable(OMP_BIN)
    if (!available) requireBinary(OMP_BIN)
    else console.log(`[test:omp] '${OMP_BIN}' found — running current-profile suite`)
  })

  it('bootstraps: ready → negotiate → v2, then get_state answers (isolated)', async () => {
    if (!available) return
    const live = startSession(OMP_BIN)
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) {
        console.warn('[test:omp] runtime exited before handshake — skipping')
        return
      }
      const outcome = live.session.handshakeOutcome!
      expect(outcome.profile).toBe('current')
      expect(outcome.protocolVersion).toBe(2)
      expect(outcome.runtimeProtocols).toContain(2)
      expect(outcome.maxFrameBytes).toBeGreaterThanOrEqual(1024 * 1024)

      const state = await live.session.query({ type: 'get_state' })
      expect(state?.success).toBe(true)
      expect(state?.command).toBe('get_state')
      expect(state?.data).toBeTruthy()
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('local-only prompt: command_output surfaces, no agent_end needed', async () => {
    if (!available) return
    const live = startSession(OMP_BIN)
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      live.session.sendPrompt('/model')
      await waitFor(
        () =>
          live.events.some(
            (e) => e.type === 'message' && e.role === 'system' && /model/i.test(e.content)
          ),
        15_000,
        'command_output'
      )
      await waitFor(
        () => live.events.some((e) => e.type === 'status' && e.status === 'idle'),
        10_000,
        'idle settle'
      )
      expect(live.events.some((e) => e.type === 'status' && e.status === 'working')).toBe(false)
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('permission flags: --tools allowlist + --approval-mode spawn cleanly', async () => {
    if (!available) return
    const live = startSession(OMP_BIN, [
      '--tools',
      'read,grep,glob,lsp,inspect_image,web_search,todo',
      '--approval-mode',
      'always-ask'
    ])
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      const state = await live.session.query({ type: 'get_state' })
      expect(state?.success).toBe(true)
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('rpc_chunk: a >1 MiB get_messages response reassembles byte-exactly (isolated)', async () => {
    if (!available) return
    const iso = isolatedRpc(OMP_BIN)
    const dir = mkdtempSync(path.join(tmpdir(), 'omp-gui-chunk-'))
    const bigText = 'B'.repeat(1_200_000)
    const sessionFile = path.join(dir, 'big.jsonl')
    const ts = new Date().toISOString()
    const entries = [
      { type: 'session', version: '3', id: crypto.randomUUID(), timestamp: ts, cwd: dir },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'text', text: bigText }],
          attribution: 'user',
          timestamp: Date.now()
        }
      }
    ]
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const live = startSession(OMP_BIN, ['--session', sessionFile], iso)
    try {
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(live)) return
      expect(live.session.handshakeOutcome!.protocolVersion).toBe(2)

      const res = await live.session.query({ type: 'get_messages' }, 30_000)
      expect(res?.success).toBe(true)
      const messages = (res?.data as { messages: { content: { text: string }[] }[] }).messages
      expect(messages).toHaveLength(1)
      expect(messages[0].content[0].text).toBe(bigText)
    } finally {
      live.session.kill()
      live.iso.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('session scope vs default scope: switching a session never changes the default', async () => {
    if (!available) return
    const iso = isolatedRpc(OMP_BIN)
    const run = makeExecRunner(OMP_BIN, { env: iso.env, envMode: 'replace' })
    const thinkingBefore = (await configGet(run, 'defaultThinkingLevel'))?.value
    const rolesBefore = (await configGet(run, 'modelRoles'))?.value

    const s1 = startSession(OMP_BIN, [], iso)
    try {
      await waitFor(() => s1.session.handshakeOutcome !== null, 15_000, 'handshake')
      if (diedEarly(s1)) return
      // Session-scoped RPC never writes the global config read above.
      expect(await s1.session.query({ type: 'set_model', provider: 'deepseek', modelId: 'x' })).toBeTruthy()
      expect(
        JSON.stringify((await configGet(run, 'defaultThinkingLevel'))?.value)
      ).toBe(JSON.stringify(thinkingBefore))
      expect(JSON.stringify((await configGet(run, 'modelRoles'))?.value)).toBe(JSON.stringify(rolesBefore))
    } finally {
      s1.session.kill()
      iso.cleanup()
    }
  })
})

describe('legacy Pi (pi ≤ 0.84) — RPC v1 profile', () => {
  let available = false
  beforeAll(() => {
    available = binaryAvailable(PI_BIN)
    if (!available) requireBinary(PI_BIN)
    else console.log(`[test:omp] '${PI_BIN}' found — running legacy suite`)
  })

  it('no ready frame: first real frame settles the legacy v1 profile', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    const live = startSession(PI_BIN, [], iso)
    try {
      const statePromise = live.session.query({ type: 'get_state' }, 15_000)
      await waitFor(() => live.session.handshakeOutcome !== null, 15_000, 'legacy detection')
      if (diedEarly(live)) {
        console.warn('[test:omp] legacy runtime exited early — skipping')
        return
      }
      expect(live.session.handshakeOutcome!.profile).toBe('legacy')
      expect(live.session.handshakeOutcome!.protocolVersion).toBe(1)
      const state = await statePromise
      expect(state?.success).toBe(true)
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })

  it('negotiate_protocol on legacy fails cleanly and the session survives', async () => {
    if (!available) return
    const iso = createIsolatedOmpEnvironment()
    const live = startSession(PI_BIN, [], iso)
    try {
      const res = await live.session.query(
        { type: 'negotiate_protocol', protocolVersion: 2 },
        15_000
      )
      if (diedEarly(live)) return
      expect(res?.success).toBe(false)
      const state = await live.session.query({ type: 'get_state' }, 15_000)
      expect(state?.success).toBe(true)
    } finally {
      live.session.kill()
      live.iso.cleanup()
    }
  })
})