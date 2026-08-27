import { describe, it, expect } from 'vitest'
import {
  GUI_SUPPORTED_PROTOCOLS,
  OmpHandshake,
  parseReadyFrame
} from '../omp/OmpHandshake'

/**
 * Bootstrap/negotiation state machine tests — the four runtime shapes the
 * GUI must survive (docs/protocol-facts.md):
 * legacy (no ready), current v1+v2, current v1-only, future-incompatible.
 */

const READY_V12 = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864
}

function nextId(): () => string {
  let n = 0
  return () => `req-${++n}`
}

describe('OmpHandshake', () => {
  it('legacy runtime: first ordinary frame activates v1 without consuming it', () => {
    const h = new OmpHandshake()
    const step = h.handleFrame({ type: 'agent_start' }, nextId())
    expect(step.consumed).toBe(false)
    expect(h.currentState).toBe('active')
    expect(h.result).toEqual({ profile: 'legacy', protocolVersion: 1 })
    expect(h.chunksArmed).toBe(false)
  })

  it('legacy runtime: a response as the first frame also settles v1', () => {
    const h = new OmpHandshake()
    const step = h.handleFrame(
      { type: 'response', id: 'x', command: 'get_state', success: true, data: {} },
      nextId()
    )
    expect(step.consumed).toBe(false)
    expect(h.result?.profile).toBe('legacy')
  })

  it('current runtime [1,2]: ready → negotiate v2 → activated on its response', () => {
    const h = new OmpHandshake()
    const ids = nextId()
    const step1 = h.handleFrame({ ...READY_V12 }, ids)
    expect(step1.consumed).toBe(true)
    expect(h.currentState).toBe('negotiating')
    expect(step1.actions).toEqual([{ kind: 'send_negotiate', protocolVersion: 2 }])

    // Unrelated frames during negotiation pass through (wire is still v1).
    const passthrough = h.handleFrame({ type: 'available_commands_update', commands: [] }, ids)
    expect(passthrough.consumed).toBe(false)

    // A response with a different id does not settle the negotiation.
    const other = h.handleFrame(
      { type: 'response', id: 'unrelated', command: 'get_state', success: true, data: {} },
      ids
    )
    expect(other.consumed).toBe(false)
    expect(h.currentState).toBe('negotiating')

    const step2 = h.handleFrame(
      { type: 'response', id: 'req-1', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } },
      ids
    )
    expect(step2.consumed).toBe(true)
    expect(h.currentState).toBe('active')
    expect(h.result).toEqual({
      profile: 'current',
      protocolVersion: 2,
      runtimeProtocols: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864
    })
    expect(h.chunksArmed).toBe(true)
  })

  it('current runtime [1] only: activates v1 immediately, no negotiation', () => {
    const h = new OmpHandshake()
    const step = h.handleFrame(
      { ...READY_V12, supportedProtocolVersions: [1] },
      nextId()
    )
    expect(step.consumed).toBe(true)
    expect(step.actions).toEqual([
      {
        kind: 'activated',
        outcome: {
          profile: 'current',
          protocolVersion: 1,
          runtimeProtocols: [1],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864
        }
      }
    ])
    expect(h.chunksArmed).toBe(false)
  })

  it('incompatible runtime [3]: fails with both version lists in the failure', () => {
    const h = new OmpHandshake()
    const step = h.handleFrame(
      { ...READY_V12, supportedProtocolVersions: [3] },
      nextId()
    )
    expect(step.consumed).toBe(true)
    expect(h.currentState).toBe('failed')
    expect(step.actions[0].kind).toBe('failed')
    const failure = h.error!
    expect(failure.runtimeProtocols).toEqual([3])
    expect(failure.message).toMatch(/protocol/i)
    expect(GUI_SUPPORTED_PROTOCOLS).toEqual([1, 2])
  })

  it('rejected negotiation falls back to v1 (wire default)', () => {
    const h = new OmpHandshake()
    const ids = nextId()
    h.handleFrame({ ...READY_V12 }, ids)
    const step = h.handleFrame(
      {
        type: 'response',
        id: 'req-1',
        command: 'negotiate_protocol',
        success: false,
        error: 'Unsupported RPC protocol version: 2'
      },
      ids
    )
    expect(step.consumed).toBe(true)
    expect(h.result?.protocolVersion).toBe(1)
    expect(h.result?.profile).toBe('current')
    expect(h.chunksArmed).toBe(false)
  })

  it('negotiation timeout settles v1 and keeps declared limits', () => {
    const h = new OmpHandshake()
    h.handleFrame({ ...READY_V12 }, nextId())
    const step = h.negotiationTimedOut()
    expect(h.currentState).toBe('active')
    expect(h.result?.protocolVersion).toBe(1)
    expect(h.result?.maxFrameBytes).toBe(1048576)
    expect(step.actions[0].kind).toBe('activated')
    // A late negotiation response afterwards is ignored gracefully.
    const late = h.handleFrame(
      { type: 'response', id: 'req-1', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } },
      nextId()
    )
    expect(late.consumed).toBe(false)
    expect(h.result?.protocolVersion).toBe(1)
  })

  it('malformed ready frame fails loudly', () => {
    const h = new OmpHandshake()
    const step = h.handleFrame({ type: 'ready', protocolVersion: 1 }, nextId())
    expect(step.consumed).toBe(true)
    expect(h.currentState).toBe('failed')
    expect(h.error?.message).toMatch(/malformed/i)
  })

  it('ignores frames after activation without consuming them', () => {
    const h = new OmpHandshake()
    h.handleFrame({ type: 'agent_start' }, nextId())
    const step = h.handleFrame({ ...READY_V12 }, nextId())
    expect(step.consumed).toBe(false)
    expect(step.actions).toEqual([])
  })
})

describe('parseReadyFrame', () => {
  it('parses the documented ready shape', () => {
    expect(parseReadyFrame({ ...READY_V12 })).toEqual({
      runtimeProtocols: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864
    })
  })

  it('dedupes and sorts version lists', () => {
    expect(parseReadyFrame({ type: 'ready', supportedProtocolVersions: [2, 1, 2] }))
      .toMatchObject({ runtimeProtocols: [1, 2] })
  })

  it('rejects missing/empty/garbage version lists', () => {
    expect(parseReadyFrame({ type: 'ready' })).toBeNull()
    expect(parseReadyFrame({ type: 'ready', supportedProtocolVersions: [] })).toBeNull()
    expect(parseReadyFrame({ type: 'ready', supportedProtocolVersions: ['2'] })).toBeNull()
  })

  it('drops implausible declared limits instead of trusting them', () => {
    const parsed = parseReadyFrame({
      type: 'ready',
      supportedProtocolVersions: [1],
      maxFrameBytes: -5,
      maxReassembledFrameBytes: Number.MAX_SAFE_INTEGER
    })
    expect(parsed?.maxFrameBytes).toBeUndefined()
    expect(parsed?.maxReassembledFrameBytes).toBeUndefined()
  })
})
