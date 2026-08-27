import { describe, it, expect, beforeAll } from 'vitest'
import { createIsolatedOmpEnvironment, binaryAvailable } from './isolated-runtime'

/**
 * Optional live provider smoke test — OPT-IN ONLY.
 *
 * Run explicitly with:
 *   OMP_GUI_RUN_LIVE_TESTS=1 pnpm test:omp:live
 *
 * May use configured provider credentials and consume tokens. It is never
 * invoked by `pnpm test`, `pnpm test:omp`, or CI. Every mutation runs in an
 * isolated temp config/profile so the user's real default model, thinking,
 * skills, enabledModels and modelRoles are untouched.
 */
const RUN_LIVE = process.env.OMP_GUI_RUN_LIVE_TESTS === '1'

describe('live provider smoke test', () => {
  beforeAll(() => {
    if (!RUN_LIVE) console.warn('[test:omp:live] skipped — set OMP_GUI_RUN_LIVE_TESTS=1 (may consume tokens)')
  })

  it('performs a single real inference against the runtime (opt-in)', async () => {
    if (!RUN_LIVE) return
    const bin = process.env.OMP_BIN || 'omp'
    if (!binaryAvailable(bin)) {
      console.warn(`[test:omp:live] '${bin}' not found — skipping`)
      return
    }
    // Isolated HOME/agent dir; only credentials ride on process.env here.
    const iso = createIsolatedOmpEnvironment({ credentials: true })
    try {
      const proc = iso.spawnRpc(bin)
      const { OmpSession } = await import('../../src/main/omp/OmpSession')
      const events: unknown[] = []
      const session = new OmpSession(
        { id: 'live', cwd: iso.agentDir, title: 'live', createdAt: Date.now(), status: 'idle' },
        proc as never,
        { label: bin, onEvent: (e) => events.push(e) }
      )
      try {
        session.sendPrompt('Reply with exactly: PONG')
        const start = Date.now()
        await new Promise<void>((resolve, reject) => {
          const tick = () => {
            const done = events.some((e) => (e as { type: string }).type === 'status' && (e as { status: string }).status === 'idle')
            if (done) return resolve()
            if (Date.now() - start > 90_000) return reject(new Error('timed out waiting for live turn'))
            setTimeout(tick, 100)
          }
          tick()
        })
        expect(session.lastAssistantText).toContain('PONG')
      } finally {
        session.kill()
      }
    } finally {
      iso.cleanup()
    }
  })
})