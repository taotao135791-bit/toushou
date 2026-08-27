import {
  ExtensionUiAnswer,
  PromptImage,
  Session,
  SessionEvent,
  SessionRuntimeState,
  StreamingBehavior,
  SubagentMessagesResult,
  SubagentSnapshot,
  SubagentSubscriptionLevel,
  SubagentTranscriptSelector,
  RpcOutcome
} from '../../shared/types'
import {
  LineReader,
  RpcFrameDecoder,
  RpcFrameError,
  serializeCommand,
  StderrRing
} from './OmpTransport'
import { GUI_SUPPORTED_PROTOCOLS, HandshakeOutcome, OmpHandshake } from './OmpHandshake'
import { extensionUiResponse, normalizeRpcFrame } from './OmpProtocol'

/** An extension may only hold a bounded number of unresolved host dialogs. */
const MAX_PENDING_EXTENSION_UI_REQUESTS = 20

/**
 * One live `pi/omp --mode rpc` session: the child process, its transport
 * (physical JSONL + logical v2 chunk reassembly), the protocol handshake,
 * in-flight RPC queries, prompt tracking and an explicit runtime state
 * machine.
 *
 * The process is injected (a real ChildProcess in production, an
 * EventEmitter-based fake in tests); this class never spawns by itself —
 * assembly lives in OmpProcess.
 *
 * Frame pipeline (stdout):
 *
 *   bytes → LineReader → JSON.parse → OmpHandshake (until active)
 *         → RpcFrameDecoder (rpc_chunk reassembly)
 *         → pending query/prompt claim (matched by request id)
 *         → normalizeRpcFrame → SessionEvent
 *
 * Session lifecycle state machine (SessionRuntimeState):
 *
 * | from                          | trigger                                | to               | emitted                     |
 * |-------------------------------|----------------------------------------|------------------|-----------------------------|
 * | starting                      | constructor (process wired)            | idle             | connected                   |
 * | idle                          | agent_start                            | working          | status:working              |
 * | working                       | interactive extension_ui_request       | waiting_for_user | ui_request                  |
 * | waiting_for_user              | respondExtensionUi                     | working          | — (renderer stays busy)     |
 * | working / waiting_for_user    | abort()                                | aborting         | —                           |
 * | aborting / working            | agent_end (isTerminal !== false)       | idle             | status:idle                 |
 * | working                       | agent_end with isTerminal === false    | working          | — (suppressed)              |
 * | idle                          | prompt ack/result agentInvoked=false   | idle             | status:idle (optimistic-busy clear) |
 * | working / aborting / waiting… | provider error (message_end)           | idle             | error + status:idle         |
 * | any (not closed)              | handshake found no common protocol     | failed → closed  | error → closed              |
 * | any (not closed)              | process exit, code ≠ 0                 | failed → closed  | error(+stderr tail) → closed|
 * | any (not closed)              | process exit, code 0 / null            | closed           | closed                      |
 * | any (not closed)              | process 'error' (spawn failure)        | failed → closed  | error → closed              |
 * | any                           | kill()                                 | closed           | — (renderer initiated)      |
 *
 * Failed command responses (rejected prompt/steer/…) are surfaced as error
 * events but NEVER end the turn — a rejection is not a terminal condition;
 * only agent_end (terminal), a provider error, or process exit settles a
 * turn. Duplicate status events are suppressed so the renderer never drains
 * its queue twice for one turn. Pending RPC queries all resolve(null) on
 * failed/closed.
 */
export class OmpSession {
  readonly session: Session
  private readonly id: string
  private state: SessionRuntimeState = 'starting'
  private readonly pending = new Map<string, PendingQuery>()
  /** Request ids of prompts whose ack we still expect. */
  private readonly pendingPrompts = new Set<string>()
  /** Active extension dialogs, keyed by the upstream request id. */
  private readonly pendingExtensionUi = new Set<string>()
  /** Avoid repeating the same host-capability diagnostic throughout a turn. */
  private readonly unsupportedExtensionUiMethods = new Set<string>()
  private readonly reader = new LineReader()
  private readonly decoder = new RpcFrameDecoder()
  private readonly handshake = new OmpHandshake()
  private negotiateTimer: ReturnType<typeof setTimeout> | null = null
  /** The id OmpHandshake minted for the in-flight negotiate command. */
  private lastNegotiateId: string | null = null
  private readonly stderrRing = new StderrRing()
  /** Assistant text of the in-flight turn, accumulated from text deltas. */
  private draftText = ''
  /** Finalized assistant text of the last completed turn (for notifications). */
  private assistantText = ''

  constructor(
    session: Session,
    private readonly proc: OmpProcessLike,
    private readonly options: OmpSessionOptions
  ) {
    this.session = session
    this.id = session.id
    proc.stdout?.on('data', (chunk: Buffer) => this.handleChunk(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => this.stderrRing.push(chunk))
    proc.on('error', (err: Error) => this.handleProcessError(err))
    proc.on('exit', (code: number | null) => this.handleExit(code))
    this.state = 'idle'
    this.emit({ type: 'connected', sessionId: this.id })
  }

  get runtimeState(): SessionRuntimeState {
    return this.state
  }

  /** Settled handshake outcome (profile, protocol, limits), once known. */
  get handshakeOutcome(): HandshakeOutcome | null {
    return this.handshake.result
  }

  /** Assistant text produced by the session's last completed turn ('' if none). */
  get lastAssistantText(): string {
    return this.assistantText
  }

  private get alive(): boolean {
    return this.state !== 'closed' && this.state !== 'failed'
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event)
  }

  /** Debug-only log channel (never carries user content). */
  private debug(message: string): void {
    this.options.onDebug?.(message)
  }

  // ---------------------------------------------------------------- stdin

  private writeLine(line: string): boolean {
    if (!this.alive || !this.proc.stdin) return false
    try {
      // Writable.write() returning false means backpressure, not rejection: the
      // frame was accepted and must not be sent a second time.
      this.proc.stdin.write(line)
      return true
    } catch (err) {
      this.debug(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private write(payload: Record<string, unknown>): boolean {
    return this.writeLine(serializeCommand(payload))
  }

  /** Send a user prompt. */
  sendPrompt(text: string, images?: PromptImage[], streamingBehavior?: StreamingBehavior): boolean {
    const id = crypto.randomUUID()
    const ok = this.write({
      id,
      type: 'prompt',
      message: text,
      ...(images?.length ? { images } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {})
    })
    if (ok) this.pendingPrompts.add(id)
    return ok
  }

  /** Ask the agent to abort the current turn; converges at agent_end/exit. */
  abort(): boolean {
    const ok = this.write({ id: crypto.randomUUID(), type: 'abort' })
    if (ok && (this.state === 'working' || this.state === 'waiting_for_user')) {
      this.state = 'aborting'
    }
    return ok
  }

  /** Answer (or cancel) a pending interactive extension UI dialog. */
  respondExtensionUi(requestId: string, answer: ExtensionUiAnswer): boolean {
    if (!this.pendingExtensionUi.has(requestId)) {
      this.debug(`ignored extension UI response for unknown request ${requestId}`)
      return false
    }
    if (!this.writeLine(extensionUiResponse(requestId, answer))) return false
    this.pendingExtensionUi.delete(requestId)
    if (this.state === 'waiting_for_user' && this.pendingExtensionUi.size === 0) {
      this.state = 'working'
    }
    return true
  }

  /** Hot-switch the model via the RPC set_model command. */
  setModel(provider: string, modelId: string): boolean {
    return this.write({ id: crypto.randomUUID(), type: 'set_model', provider, modelId })
  }

  /** Enable/disable the subagent event subscription (current profile only). */
  async setSubagentSubscription(level: SubagentSubscriptionLevel): Promise<RpcOutcome<{ level: SubagentSubscriptionLevel }>> {
    const res = await this.query({ type: 'set_subagent_subscription', level })
    return classifyRpcResponse(res, 'set_subagent_subscription', (data) =>
      data && typeof data === 'object' ? (data as { level: SubagentSubscriptionLevel }) : null
    )
  }

  /** Fetch the live subagent roster (`get_subagents`). */
  async getSubagents(): Promise<RpcOutcome<SubagentSnapshot[]>> {
    const res = await this.query({ type: 'get_subagents' })
    return classifyRpcResponse(res, 'get_subagents', (data) => {
      const subagents = (data as { subagents?: unknown } | null)?.subagents
      return Array.isArray(subagents) ? (subagents as SubagentSnapshot[]) : null
    })
  }

  /**
   * Incrementally read a child agent's transcript (`get_subagent_messages`).
   * `fromByte` supports cursor-based incremental reads; a missing session file
   * returns an empty result rather than throwing (upstream contract).
   */
  async getSubagentMessages(selector: SubagentTranscriptSelector): Promise<RpcOutcome<SubagentMessagesResult>> {
    const res = await this.query({ type: 'get_subagent_messages', ...selector })
    return classifyRpcResponse(res, 'get_subagent_messages', (data) =>
      data && typeof data === 'object' ? (data as SubagentMessagesResult) : null
    )
  }

  /**
   * Send an RPC command and await its response, matched by request id.
   * Resolves null on timeout, dead session, or process exit.
   */
  query(command: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown> | null> {
    if (!this.alive) return Promise.resolve(null)
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { resolve, timer, commandType: String(command.type ?? '') })
      if (!this.writeLine(serializeCommand({ id, ...command }))) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  /** Kill the process and close the session (renderer-initiated; no events). */
  kill(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.clearNegotiateTimer()
    this.resolvePending(null)
    try {
      this.proc.kill()
    } catch {
      // already dead — fine
    }
    this.options.onGone?.()
  }

  // --------------------------------------------------------------- stdout

  private handleChunk(chunk: Buffer): void {
    // A closed session ignores any residual output (e.g. the process is
    // still flushing after a failed handshake killed it).
    if (this.state === 'closed') return
    for (const event of this.reader.push(chunk)) {
      if (event.kind === 'line') {
        this.handleLine(event.line)
      } else {
        // Transport-level problem (oversize line); the session stays alive.
        this.emit({ type: 'error', sessionId: this.id, message: event.message, recoverable: true })
      }
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line)
    } catch {
      // Not JSON — surface as plain assistant text (legacy behavior).
      this.handleEvent({ type: 'message', sessionId: this.id, role: 'assistant', content: line })
      return
    }

    // 1. Handshake: consumes ready / negotiate-response frames until active.
    if (this.handshake.currentState !== 'active' && this.handshake.currentState !== 'failed') {
      const step = this.handshake.handleFrame(frame, () => {
        const id = crypto.randomUUID()
        this.lastNegotiateId = id
        return id
      })
      for (const action of step.actions) this.applyHandshakeAction(action)
      if (step.consumed) return
    }

    // 2. Logical reassembly. Every parsed object passes through the decoder
    //    so an interrupted chunk sequence is reported even by a non-chunk.
    let logical: Record<string, unknown>
    if (frame.type === 'rpc_chunk' && !this.handshake.chunksArmed) {
      // Matches the official client: chunks before v2 was negotiated are a
      // protocol violation, not data.
      this.debug('rpc_chunk received before protocol negotiation')
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: 'RPC chunk received before protocol negotiation',
        recoverable: true
      })
      return
    }
    try {
      const out = this.decoder.push(frame)
      if (out === undefined) return // chunk accepted, sequence incomplete
      logical = out as Record<string, unknown>
    } catch (err) {
      if (err instanceof RpcFrameError) {
        this.debug(`rpc frame rejected (${err.code})`)
        this.emit({
          type: 'error',
          sessionId: this.id,
          message: `RPC frame rejected: ${err.message}`,
          recoverable: true
        })
        return
      }
      throw err
    }

    // 3. Bookkeeping claims by request id before semantic normalization.
    if (logical.type === 'response' && typeof logical.id === 'string') {
      const query = this.pending.get(logical.id)
      if (query) {
        this.pending.delete(logical.id)
        clearTimeout(query.timer)
        query.resolve(logical)
        return
      }
      if (this.pendingPrompts.delete(logical.id)) {
        this.handlePromptAck(logical)
        return
      }
    }
    // 3b. id-less failure correlation. Older OMP builds answer an unknown
    // command with `{ success:false, error:"Unknown command: X" }` and NO id.
    // Correlate that ONLY when the parsed command matches EXACTLY ONE pending
    // request — never guess across multiple same-type requests, and never treat
    // a non-"Unknown command:" id-less error as an answer.
    if (logical.type === 'response' && logical.success === false && typeof logical.id !== 'string') {
      const commandType = parseUnknownCommandError(logical.error)
      if (commandType) {
        const matches = [...this.pending.entries()].filter(([, q]) => q.commandType === commandType)
        if (matches.length === 1) {
          const [pendingId, q] = matches[0]
          this.pending.delete(pendingId)
          clearTimeout(q.timer)
          q.resolve(logical)
          return
        }
      }
    }
    if (logical.type === 'prompt_result') {
      this.handlePromptResult({ agentInvoked: logical.agentInvoked === true })
      return
    }

    // 4. Semantics.
    const result = normalizeRpcFrame(logical, this.id)
    this.applyParseResult(result)
  }

  private applyParseResult(result: ReturnType<typeof normalizeRpcFrame>): void {
    switch (result.kind) {
      case 'event':
        this.handleEvent(result.event)
        return
      case 'extension_ui':
        if (this.pendingExtensionUi.has(result.id)) {
          this.emit({
            type: 'error',
            sessionId: this.id,
            message: 'Extension sent a duplicate interactive request id; the duplicate was ignored.',
            recoverable: true
          })
          return
        }
        if (this.pendingExtensionUi.size >= MAX_PENDING_EXTENSION_UI_REQUESTS) {
          this.emit({
            type: 'error',
            sessionId: this.id,
            message: 'Extension opened too many interactive requests; the newest request was ignored.',
            recoverable: true
          })
          return
        }
        this.pendingExtensionUi.add(result.id)
        // Forward interactive extension dialogs to the renderer; the answer
        // comes back through respondExtensionUi().
        this.emit({
          type: 'ui_request',
          sessionId: this.id,
          id: result.id,
          method: result.method,
          title: result.title,
          message: result.message,
          options: result.options,
          placeholder: result.placeholder,
          prefill: result.prefill,
          timeout: result.timeout
        })
        if (this.state === 'working') {
          this.state = 'waiting_for_user'
        }
        return
      case 'extension_ui_cancel':
        if (!this.pendingExtensionUi.delete(result.targetId)) return
        this.emit({ type: 'ui_cancel', sessionId: this.id, id: result.targetId })
        // The dismissed dialog resolves as cancelled runtime-side; the turn
        // continues, so leave waiting_for_user like a user answer would.
        if (this.state === 'waiting_for_user' && this.pendingExtensionUi.size === 0) {
          this.state = 'working'
        }
        return
      case 'extension_ui_invalid':
        this.emit({ type: 'error', sessionId: this.id, message: result.reason, recoverable: true })
        return
      case 'extension_ui_unsupported':
        if (!this.unsupportedExtensionUiMethods.has(result.method)) {
          this.unsupportedExtensionUiMethods.add(result.method)
          this.emit({
            type: 'message',
            sessionId: this.id,
            role: 'system',
            content: `An installed extension requested unsupported host UI: ${result.method}.`
          })
        }
        return
      case 'open_url':
        this.options.onOpenUrl?.(result.url, result.launchUrl, result.instructions)
        return
      case 'prompt_result':
        this.handlePromptResult({ agentInvoked: result.agentInvoked })
        return
      case 'command_failed':
        // A rejected command (e.g. a mid-stream prompt without steer/
        // followUp) is reported but NEVER settles the turn — the running
        // turn keeps its own terminal event.
        this.debug(`rpc command failed (${result.command ?? 'unknown'})`)
        this.emit({ type: 'error', sessionId: this.id, message: result.message, recoverable: true })
        return
      case 'none':
        return
    }
  }

  // ------------------------------------------------------------ handshake

  private applyHandshakeAction(action: {
    kind: string
    protocolVersion?: number
    outcome?: HandshakeOutcome
    failure?: { message: string; runtimeProtocols?: number[] }
  }): void {
    if (action.kind === 'send_negotiate' && typeof action.protocolVersion === 'number') {
      // The handshake generated the request id; recover it by re-asking the
      // handleFrame caller — it stashed the id on the command we write here.
      // (OmpHandshake owns the id it created via the requestId callback.)
      const id = this.lastNegotiateId
      this.write({ id, type: 'negotiate_protocol', protocolVersion: action.protocolVersion })
      this.clearNegotiateTimer()
      this.negotiateTimer = setTimeout(() => {
        this.negotiateTimer = null
        const step = this.handshake.negotiationTimedOut()
        for (const a of step.actions) this.applyHandshakeAction(a)
      }, NEGOTIATE_TIMEOUT_MS)
      return
    }
    if (action.kind === 'activated' && action.outcome) {
      this.clearNegotiateTimer()
      const outcome = action.outcome
      this.debug(
        outcome.profile === 'legacy'
          ? 'rpc profile: legacy (no ready frame)'
          : `rpc profile: current, protocol v${outcome.protocolVersion}`
      )
      this.options.onHandshake?.(outcome)
      return
    }
    if (action.kind === 'failed' && action.failure) {
      this.clearNegotiateTimer()
      const runtime = action.failure.runtimeProtocols?.join(', ') || 'unknown'
      const gui = GUI_SUPPORTED_PROTOCOLS.join(', ')
      this.emit({
        type: 'error',
        sessionId: this.id,
        message:
          `${action.failure.message}\n` +
          `Runtime supported RPC versions: ${runtime}. GUI supported RPC versions: ${gui}.`,
        recoverable: false
      })
      // Talking further would be guesswork — close the session cleanly.
      this.state = 'failed'
      this.resolvePending(null)
      try {
        this.proc.kill()
      } catch {
        // already dead — fine
      }
      this.state = 'closed'
      this.emit({ type: 'closed', sessionId: this.id })
      this.options.onGone?.()
    }
  }

  private clearNegotiateTimer(): void {
    if (this.negotiateTimer) {
      clearTimeout(this.negotiateTimer)
      this.negotiateTimer = null
    }
  }

  // -------------------------------------------------------- prompt lifecycle

  /**
   * The prompt ack arrives immediately; success does NOT mean the turn
   * finished. `data.agentInvoked === false` marks a local-only completion
   * (slash command): no agent_start/agent_end will follow.
   */
  private handlePromptAck(frame: Record<string, unknown>): void {
    if (frame.success === false) {
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: String(frame.error ?? 'Prompt rejected'),
        recoverable: true
      })
      // A rejected prompt never starts a turn — release the renderer's
      // optimistic busy when nothing else is running.
      this.settleLocalPrompt()
      return
    }
    const data = frame.data
    const agentInvoked =
      typeof data === 'object' && data !== null
        ? (data as { agentInvoked?: unknown }).agentInvoked !== false
        : true
    if (!agentInvoked) this.settleLocalPrompt()
  }

  private handlePromptResult(frame: { agentInvoked: boolean }): void {
    if (!frame.agentInvoked) this.settleLocalPrompt()
  }

  /**
   * A prompt that completed locally produces no agent events. When no real
   * turn is running, emit the idle transition the renderer is waiting for
   * (its optimistic busy would otherwise stick forever, stalling the queue).
   * Mid-turn local commands change nothing: the running turn keeps working.
   */
  private settleLocalPrompt(): void {
    if (this.state === 'idle') {
      this.emit({ type: 'status', sessionId: this.id, status: 'idle', isTerminal: true })
    }
  }

  // ---------------------------------------------------------------- events

  private handleEvent(event: SessionEvent): void {
    if (event.type === 'message' && event.role === 'assistant') {
      this.draftText += event.content
    }

    if (event.type === 'status' && event.status === 'working') {
      // agent_start — duplicate starts are suppressed (they would reset the
      // renderer's turn counters).
      if (this.state !== 'working') {
        this.state = 'working'
        this.emit(event)
      }
      return
    }

    if (event.type === 'status' && event.status === 'idle') {
      // agent_end — an explicit isTerminal:false marks a non-terminal end
      // (maintenance / async delivery follows); honor that and keep the
      // turn open.
      if (event.isTerminal === false) return
      if (this.state !== 'idle') {
        this.cancelPendingExtensionUi()
        this.state = 'idle'
        this.finalizeDraft()
        this.emit(event)
      }
      return
    }

    if (event.type === 'error' && event.recoverable !== true) {
      this.emit(event)
      this.cancelPendingExtensionUi()
      this.finalizeDraft()
      // A provider failure ends the turn even without agent_end.
      if (
        this.state === 'working' ||
        this.state === 'aborting' ||
        this.state === 'waiting_for_user'
      ) {
        this.state = 'idle'
        this.emit({ type: 'status', sessionId: this.id, status: 'idle' })
      }
      return
    }

    this.emit(event)
  }

  private finalizeDraft(): void {
    this.assistantText = this.draftText
    this.draftText = ''
  }

  /** Drop stale dialogs whenever the runtime settles or dies. */
  private cancelPendingExtensionUi(): void {
    for (const id of this.pendingExtensionUi) {
      this.emit({ type: 'ui_cancel', sessionId: this.id, id })
    }
    this.pendingExtensionUi.clear()
  }

  // --------------------------------------------------------- process end

  private resolvePending(value: Record<string, unknown> | null): void {
    for (const query of this.pending.values()) {
      clearTimeout(query.timer)
      query.resolve(value)
    }
    this.pending.clear()
    this.pendingPrompts.clear()
    this.pendingExtensionUi.clear()
  }

  /** Spawn failure (ENOENT, EACCES, …). */
  private handleProcessError(err: Error): void {
    if (this.state === 'closed') return
    this.clearNegotiateTimer()
    this.resolvePending(null)
    this.state = 'failed'
    this.emit({
      type: 'error',
      sessionId: this.id,
      message: `Failed to start ${this.options.label ?? 'omp'}: ${err.message}`,
      recoverable: false
    })
    this.state = 'closed'
    this.emit({ type: 'closed', sessionId: this.id })
    this.options.onGone?.()
  }

  private handleExit(code: number | null): void {
    if (this.state === 'closed') return
    this.clearNegotiateTimer()
    // Surface a trailing line that never got its LF before wrapping up.
    for (const event of this.reader.flush()) {
      if (event.kind === 'line') this.handleLine(event.line)
    }
    this.decoder.reset()
    this.resolvePending(null)
    if (code !== 0 && code !== null) {
      this.state = 'failed'
      const detail = this.stderrRing.tail(3)
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: `omp exited with code ${code}${detail ? `\n${detail}` : ''}`,
        recoverable: false
      })
    }
    this.state = 'closed'
    this.emit({ type: 'closed', sessionId: this.id })
    this.options.onGone?.()
  }
}

const NEGOTIATE_TIMEOUT_MS = 5_000

interface PendingQuery {
  resolve: (payload: Record<string, unknown> | null) => void
  timer: ReturnType<typeof setTimeout>
  /** The command type of this request, for safe id-less error correlation. */
  commandType: string
}

/**
 * Classify one RPC response frame into a normalized outcome. The key
 * distinction: a `success:false` response that is NOT `Unknown command: …`
 * still PROVES the command exists (supported) — only `Unknown command:` means
 * unsupported. A null response (timeout / transport / process death) is
 * `unknown`, never `unsupported`.
 */
export function classifyRpcResponse<T>(
  res: Record<string, unknown> | null,
  command: string,
  parse: (data: unknown) => T | null
): RpcOutcome<T> {
  if (res === null) return { kind: 'unknown' }
  if (res.success === true) {
    const data = parse(res.data)
    if (data !== null) return { kind: 'success', data }
    // success:true but the data did not parse — a protocol mismatch, not a
    // capability verdict.
    return { kind: 'unknown', error: 'malformed response' }
  }
  const error = typeof res.error === 'string' ? res.error : `Unknown error (${command})`
  const code = typeof res.code === 'string' ? res.code : undefined
  if (error.startsWith('Unknown command:')) {
    return { kind: 'unsupported', error, code }
  }
  return { kind: 'command-error', error, code }
}

/** Strictly parse an OMP `Unknown command: X` error; null for anything else. */
const UNKNOWN_COMMAND_RE = /^Unknown command: ([A-Za-z_][A-Za-z0-9_]*)\s*$/

export function parseUnknownCommandError(error: unknown): string | null {
  if (typeof error !== 'string') return null
  const match = UNKNOWN_COMMAND_RE.exec(error.trim())
  return match ? match[1] : null
}

/**
 * Structural subset of ChildProcess this class relies on — an
 * EventEmitter-based fake satisfies it in tests.
 */
export interface OmpProcessLike {
  stdin: { write(data: string): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  kill(): void
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'exit', cb: (code: number | null) => void): unknown
}

export interface OmpSessionOptions {
  onEvent: (event: SessionEvent) => void
  /** CLI command name, used in spawn-failure messages. */
  label?: string
  /** Registry cleanup once the session is gone (exit/error/kill). */
  onGone?: () => void
  /** Settled handshake outcome (capabilities/diagnostics bookkeeping). */
  onHandshake?: (outcome: HandshakeOutcome) => void
  /** The runtime asked to open a URL (OAuth login flows); main wires shell. */
  onOpenUrl?: (url: string, launchUrl?: string, instructions?: string) => void
  /** Debug-only log channel — never receives user content. */
  onDebug?: (message: string) => void
}
