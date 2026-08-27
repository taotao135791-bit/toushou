/**
 * RPC bootstrap & protocol negotiation (docs/protocol-facts.md):
 *
 * Current Oh My Pi (≥ the omp.sh lineage) opens the stream with a `ready`
 * frame declaring the protocol versions it supports plus its frame limits;
 * the host picks the highest mutually supported version and, when that is
 * 2, activates it with a `negotiate_protocol` command. Legacy Pi (≤ 0.84)
 * sends no ready frame and no handshake at all — the first frame on the
 * wire is an ordinary response/event.
 *
 * This class is the state machine for that opening dance:
 *
 *   bootstrapping ──ready frame──▶ negotiating ──success──▶ active (v2)
 *        │                            │
 *        │                            ├──failure/timeout──▶ active (v1, wire default)
 *        │                            └──no common version─▶ failed (compatibility error)
 *        │
 *        └──any other frame──────────▶ active (legacy v1; frame passes through)
 *
 * Everything stays writable in every state: the wire format before
 * negotiation is v1 JSONL in both profiles, so commands may be sent
 * immediately without waiting for the handshake to settle.
 *
 * Pure logic — no I/O, no Electron — so the state machine is unit-testable.
 */

/** RPC protocol versions this host can speak, highest preference last. */
export const GUI_SUPPORTED_PROTOCOLS: readonly number[] = [1, 2]

/** Defensive bounds for a runtime-declared frame limit (1 KiB … 1 GiB). */
const MIN_DECLARED_LIMIT = 1024
const MAX_DECLARED_LIMIT = 1024 * 1024 * 1024

/** Runtime profile detected during bootstrap. */
export type RuntimeProfile = 'legacy' | 'current'

export type HandshakeState = 'bootstrapping' | 'negotiating' | 'active' | 'failed'

export interface HandshakeOutcome {
  profile: RuntimeProfile
  /** Protocol version the session ended up speaking. */
  protocolVersion: 1 | 2
  /** Versions the runtime advertised (current profile only). */
  runtimeProtocols?: number[]
  maxFrameBytes?: number
  maxReassembledFrameBytes?: number
}

/** A declared incompatibility between runtime and host protocol surfaces. */
export interface HandshakeFailure {
  message: string
  runtimeProtocols?: number[]
}

export type HandshakeAction =
  | { kind: 'send_negotiate'; protocolVersion: number }
  | { kind: 'activated'; outcome: HandshakeOutcome }
  | { kind: 'failed'; failure: HandshakeFailure }

export interface HandshakeStep {
  /** True when the frame was part of the handshake itself (ready/response). */
  consumed: boolean
  actions: HandshakeAction[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLimit(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_DECLARED_LIMIT &&
    value <= MAX_DECLARED_LIMIT
    ? value
    : undefined
}

/** Parse and validate a `ready` frame; null when the shape is not usable. */
export function parseReadyFrame(frame: Record<string, unknown>): {
  runtimeProtocols: number[]
  maxFrameBytes?: number
  maxReassembledFrameBytes?: number
} | null {
  const raw = frame.supportedProtocolVersions
  const runtimeProtocols = Array.isArray(raw)
    ? Array.from(new Set(raw.filter((v): v is number => Number.isSafeInteger(v)))).sort(
        (a, b) => a - b
      )
    : []
  if (runtimeProtocols.length === 0) return null
  return {
    runtimeProtocols,
    maxFrameBytes: parseLimit(frame.maxFrameBytes),
    maxReassembledFrameBytes: parseLimit(frame.maxReassembledFrameBytes)
  }
}

export class OmpHandshake {
  private state: HandshakeState = 'bootstrapping'
  /** Request id of the in-flight negotiate_protocol command. */
  private negotiateId: string | null = null
  private outcome: HandshakeOutcome | null = null
  private failure: HandshakeFailure | null = null

  get currentState(): HandshakeState {
    return this.state
  }

  /** Settled outcome (state 'active'), or null while still opening. */
  get result(): HandshakeOutcome | null {
    return this.outcome
  }

  /** Settled failure (state 'failed'), or null otherwise. */
  get error(): HandshakeFailure | null {
    return this.failure
  }

  /** The negotiated protocol once active; 1 while still opening. */
  get protocolVersion(): 1 | 2 {
    return this.outcome?.protocolVersion ?? 1
  }

  /**
   * True while chunk frames must be rejected: the official client errors on
   * `rpc_chunk` arriving before negotiation completed, and so do we — a
   * chunk outside an active v2 session means the runtime is confused.
   */
  get chunksArmed(): boolean {
    return this.outcome?.protocolVersion === 2
  }

  /**
   * Feed a parsed frame. Handshake frames are consumed; anything else is
   * left for normal processing (consumed === false).
   */
  handleFrame(frame: Record<string, unknown>, requestId: () => string): HandshakeStep {
    switch (this.state) {
      case 'bootstrapping':
        return this.bootstrap(frame, requestId)
      case 'negotiating':
        return this.negotiating(frame)
      case 'active':
      case 'failed':
        return { consumed: false, actions: [] }
    }
  }

  private bootstrap(
    frame: Record<string, unknown>,
    requestId: () => string
  ): HandshakeStep {
    if (frame.type !== 'ready') {
      // Legacy runtime: no handshake exists — the first ordinary frame
      // settles the profile. The frame itself is NOT consumed.
      return this.activate({ profile: 'legacy', protocolVersion: 1 }, false)
    }
    const ready = parseReadyFrame(frame)
    if (!ready) {
      // A ready frame we cannot read is worse than none: fail loudly.
      this.state = 'failed'
      this.failure = { message: 'Oh My Pi sent a malformed RPC ready frame.' }
      return { consumed: true, actions: [{ kind: 'failed', failure: this.failure }] }
    }
    const common = GUI_SUPPORTED_PROTOCOLS.filter((v) => ready.runtimeProtocols.includes(v))
    if (common.length === 0) {
      this.state = 'failed'
      this.failure = {
        message:
          'This version of Oh My Pi uses an RPC protocol that this version of OMP GUI does not support.',
        runtimeProtocols: ready.runtimeProtocols
      }
      return { consumed: true, actions: [{ kind: 'failed', failure: this.failure }] }
    }
    const best = common[common.length - 1]
    const base = {
      maxFrameBytes: ready.maxFrameBytes,
      maxReassembledFrameBytes: ready.maxReassembledFrameBytes,
      runtimeProtocols: ready.runtimeProtocols
    }
    this.readyBase = base
    if (best === 1) {
      // v1 is the wire default — no negotiation round-trip needed.
      return this.activate({ profile: 'current', protocolVersion: 1, ...base }, true)
    }
    this.state = 'negotiating'
    this.negotiateId = requestId()
    return {
      consumed: true,
      actions: [{ kind: 'send_negotiate', protocolVersion: best }]
    }
  }

  private negotiating(frame: Record<string, unknown>): HandshakeStep {
    if (frame.type !== 'response') return { consumed: false, actions: [] }
    // Only the answer to OUR negotiate command settles the state; unrelated
    // responses (e.g. an early get_state) pass through untouched.
    if (typeof frame.id !== 'string' || frame.id !== this.negotiateId) {
      return { consumed: false, actions: [] }
    }
    this.negotiateId = null
    const data = isObject(frame.data) ? frame.data : undefined
    if (frame.success === true && data?.protocolVersion === 2) {
      return this.activate(
        { profile: 'current', protocolVersion: 2, ...this.pendingBase() },
        true
      )
    }
    // Negotiation rejected or malformed: v1 is the wire default and always
    // works with a runtime that offered it — settle there rather than fail.
    return this.activate({ profile: 'current', protocolVersion: 1, ...this.pendingBase() }, true)
  }

  /** The ready-frame facts captured before entering 'negotiating'. */
  private readyBase: {
    maxFrameBytes?: number
    maxReassembledFrameBytes?: number
    runtimeProtocols?: number[]
  } = {}

  private pendingBase(): typeof this.readyBase {
    return this.readyBase
  }

  /**
   * Give up on an unanswered negotiation (timer lives in OmpSession): the
   * wire stays v1, which every ready-capable runtime still speaks.
   */
  negotiationTimedOut(): HandshakeStep {
    if (this.state !== 'negotiating') return { consumed: false, actions: [] }
    this.negotiateId = null
    return this.activate({ profile: 'current', protocolVersion: 1, ...this.pendingBase() }, true)
  }

  private activate(outcome: HandshakeOutcome, consumed: boolean): HandshakeStep {
    this.state = 'active'
    this.outcome = outcome
    return { consumed, actions: [{ kind: 'activated', outcome }] }
  }
}
