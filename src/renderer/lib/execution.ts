/**
 * Execution projection — the GUI-owned fold that turns a session's normalized
 * `SessionEvent` stream into ONE source of truth for the Agent Hub, the
 * trajectory overview and the per-turn tool summary.
 *
 * This is NOT a second runtime. Oh My Pi still owns execution; this module only
 * *projects* the already-normalized events (see src/main/omp/OmpProtocol.ts)
 * into UI-facing shapes. One fold, many selectors — no per-UI copies.
 *
 * Lifecycle model (the important split):
 *   - Agents are SESSION-scoped. A subagent persists across the turns that use
 *     it (its lifecycle is driven by `subagent_lifecycle` / `subagent_progress`
 *     frames and hydrated by `get_subagents`). OMP exposes a FLAT roster (each
 *     agent links to its spawner via `parentToolCallId`, not a parent-agent id),
 *     so the graph is root + children — never a guessed tree.
 *   - Turns are PROMPT-scoped. Each `agent_start` opens a fresh TurnProjection;
 *     each terminal `agent_end` closes it. Tool counts, reasoning coalescing and
 *     trajectory are per-turn; a session total is DERIVED (sum over turns), never
 *     a second increment.
 *
 * Pure functions, no React, no Electron — unit-testable in isolation.
 */

import type { SessionEvent, SubagentSnapshot, SubagentStatus, SessionRuntimeState, SubagentTelemetry, HistoricalAgentRecord } from '@shared/types'

export type AgentStatus = SubagentStatus | 'unknown'

export type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'subagent' | 'other'

export interface ToolStats {
  read: number
  search: number
  edit: number
  command: number
  subagent: number
  other: number
}

export function emptyToolStats(): ToolStats {
  return { read: 0, search: 0, edit: 0, command: 0, subagent: 0, other: 0 }
}

/**
 * The SINGLE tool-category classifier. Chat turn summaries, the trajectory and
 * any future surface all derive from this one function — never per-surface
 * switches that drift apart.
 */
export function classifyToolCall(tool: string): ToolCategory {
  const name = tool.toLowerCase()
  if (name === 'read' || name === 'ls' || name === 'cat' || name === 'head' || name === 'tail') {
    return 'read'
  }
  if (name === 'grep' || name === 'find' || name === 'rg' || name === 'search' || name === 'glob') {
    return 'search'
  }
  if (name === 'bash' || name === 'run' || name === 'exec') return 'command'
  if (name === 'edit' || name === 'write' || name === 'patch') return 'edit'
  if (name === 'subagent' || name === 'agent' || name === 'task' || name === 'spawn') {
    return 'subagent'
  }
  return 'other'
}

function addTool(stats: ToolStats, tool: string): ToolStats {
  const category = classifyToolCall(tool)
  return { ...stats, [category]: stats[category] + 1 }
}

/**
 * EXACT upstream status normalization. Only the `AgentProgress.status` /
 * lifecycle values are recognized; anything else is 'unknown' — never guessed,
 * never substring-matched, and never folded into a lossy 'cancelled'.
 */
export function normalizeOmpAgentStatus(raw: unknown): AgentStatus {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'aborted':
      return raw
    default:
      return 'unknown'
  }
}

export interface AgentNode extends SubagentTelemetry {
  /** OMP's stable registry id (children only — the root is a separate view). */
  id: string
  /** Agent definition name (e.g. 'explore', 'review'). */
  agent: string
  agentSource: 'bundled' | 'user' | 'project'
  status: AgentStatus
  description?: string
  task?: string
  assignment?: string
  sessionFile?: string
  /** The tool call that spawned this agent (not a parent-agent id). */
  parentToolCallId?: string
  index?: number
  /** Arrival timestamp of first observation — a UI estimate, not durable. */
  startedAt?: number
  /** Arrival timestamp of the terminal observation — a UI estimate, not durable. */
  endedAt?: number
  /** Runtime-reported `lastUpdate` (ms epoch). */
  lastUpdate?: number
  /** Final summary/result of a durable (historical) agent. */
  resultSummary?: string
}

export interface TrajectoryEntry {
  seq: number
  kind: 'reasoning' | 'message' | 'tool' | 'subagent' | 'steer'
  label: string
  agentId?: string
}

export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface TurnProjection {
  id: string
  startedAt?: number
  endedAt?: number
  status: TurnStatus
  tools: ToolStats
  trajectory: TrajectoryEntry[]
  /** Latest tool call + its display target ("reading src/x.ts"). */
  lastAction?: { tool: string; target: string }
}

export interface ExecutionProjection {
  agents: Record<string, AgentNode>
  rootAgentId: string
  turns: Record<string, TurnProjection>
  turnOrder: string[]
  currentTurnId?: string
  /** Monotonic per-session turn counter — the source of stable turn ids. */
  turnCounter: number
  /** The session's runtime state (working/idle/waiting_for_user/…). */
  sessionStatus: SessionRuntimeState
  /** Count of pending interactive dialogs (drives the root "waiting" status). */
  pendingUi: number
}

export const ROOT_AGENT_ID = 'main'

export function emptyProjection(_sessionId?: string): ExecutionProjection {
  return {
    agents: {},
    rootAgentId: ROOT_AGENT_ID,
    turns: {},
    turnOrder: [],
    turnCounter: 0,
    sessionStatus: 'idle',
    pendingUi: 0
  }
}

function isTerminalAgent(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

// --------------------------------------------------------------------- fold

/**
 * Fold one normalized SessionEvent into the projection. Returns a NEW projection
 * (never mutates the input) so Zustand selectors can memoize on reference
 * equality; uninteresting events return the same reference.
 */
export function foldExecutionEvent(
  state: ExecutionProjection,
  event: SessionEvent,
  now = Date.now()
): ExecutionProjection {
  switch (event.type) {
    case 'status': {
      // Track the session's runtime state for the root-agent derivation, THEN
      // handle turn boundaries. A turn boundary never mutates agent status.
      const next = { ...state, sessionStatus: event.status }
      if (event.status === 'working') return startTurn(next, now)
      if (event.status === 'idle' && event.isTerminal !== false && next.currentTurnId) {
        return endTurn(next, now, 'completed')
      }
      return next
    }

    case 'error': {
      if (event.recoverable === true) return state
      const failed = { ...state, sessionStatus: 'failed' as SessionRuntimeState }
      if (!state.currentTurnId) return failed
      return endTurn(failed, now, 'failed')
    }

    case 'ui_request':
      return { ...state, pendingUi: state.pendingUi + 1 }

    case 'ui_cancel':
      return { ...state, pendingUi: Math.max(0, state.pendingUi - 1) }

    case 'closed':
      return { ...state, sessionStatus: 'closed' }

    case 'tool_call': {
      const turn = state.currentTurnId ? state.turns[state.currentTurnId] : undefined
      if (!turn) return state
      return {
        ...state,
        turns: {
          ...state.turns,
          [turn.id]: {
            ...turn,
            tools: addTool(turn.tools, event.tool),
            lastAction: { tool: event.tool, target: toolTarget(event.tool, event.input) },
            trajectory: appendEntry(turn.trajectory, { kind: 'tool', label: event.tool })
          }
        }
      }
    }

    case 'thinking': {
      const turn = state.currentTurnId ? state.turns[state.currentTurnId] : undefined
      if (!turn) return state
      // Reasoning coalesces PER TURN — turn 2 gets its own Thinking entry.
      if (turn.trajectory.some((e) => e.kind === 'reasoning')) return state
      return {
        ...state,
        turns: {
          ...state.turns,
          [turn.id]: {
            ...turn,
            trajectory: appendEntry(turn.trajectory, { kind: 'reasoning', label: 'Thinking' })
          }
        }
      }
    }

    case 'message': {
      if (event.role !== 'assistant') return state
      const turn = state.currentTurnId ? state.turns[state.currentTurnId] : undefined
      if (!turn) return state
      return {
        ...state,
        turns: {
          ...state.turns,
          [turn.id]: {
            ...turn,
            trajectory: appendEntry(turn.trajectory, {
              kind: 'message',
              label: event.content.split('\n')[0].slice(0, 80) || 'Message'
            })
          }
        }
      }
    }

    case 'subagent': {
      return upsertAgent(state, toAgentNode(event, now), now)
    }

    default:
      return state
  }
}

/** Append a steer interaction to the ACTIVE turn's trajectory (never a new turn). */
export function foldUserSteer(
  state: ExecutionProjection,
  text: string
): ExecutionProjection {
  const turn = state.currentTurnId ? state.turns[state.currentTurnId] : undefined
  if (!turn) return state
  return {
    ...state,
    turns: {
      ...state.turns,
      [turn.id]: {
        ...turn,
        trajectory: appendEntry(turn.trajectory, {
          kind: 'steer',
          label: text.split('\n')[0].slice(0, 80) || 'Steer'
        })
      }
    }
  }
}

function appendEntry(list: TrajectoryEntry[], entry: Omit<TrajectoryEntry, 'seq'>): TrajectoryEntry[] {
  return [...list, { ...entry, seq: list.length }]
}

/** Display target of a tool call ("bash command", "read path", …). */
function toolTarget(tool: string, input: unknown): string {
  const name = tool.toLowerCase()
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (name === 'bash' && typeof obj.command === 'string') {
      return obj.command.split('\n', 1)[0].slice(0, 40)
    }
    const target = obj.path ?? obj.pattern ?? obj.query
    if (typeof target === 'string' && target) return target
  }
  return tool
}

function startTurn(state: ExecutionProjection, now: number): ExecutionProjection {
  const turnId = `turn-${state.turnCounter + 1}`
  const turn: TurnProjection = {
    id: turnId,
    startedAt: now,
    status: 'running',
    tools: emptyToolStats(),
    trajectory: []
  }
  return {
    ...state,
    turnCounter: state.turnCounter + 1,
    currentTurnId: turnId,
    turns: { ...state.turns, [turnId]: turn },
    turnOrder: [...state.turnOrder, turnId]
  }
}

/**
 * Close the current turn. This touches ONLY the TurnProjection (status/endedAt)
 * and clears `currentTurnId`. It NEVER mutates `agents` — agent status is
 * session-scoped truth, owned by subagent lifecycle/progress/snapshot events and
 * runtime reconciliation, not by turn boundaries. A detached subagent may well
 * still be running after its parent turn ends.
 */
function endTurn(
  state: ExecutionProjection,
  now: number,
  status: TurnStatus
): ExecutionProjection {
  const turnId = state.currentTurnId
  if (!turnId) return state
  const turn = state.turns[turnId]
  return {
    ...state,
    currentTurnId: undefined,
    turns: {
      ...state.turns,
      [turnId]: { ...turn, status, endedAt: now }
    }
  }
}

/** Telemetry keys preserved from OMP's AgentProgress / SingleResult. */
const TELEMETRY_KEYS: (keyof SubagentTelemetry)[] = [
  'resolvedModel',
  'resolvedModelIsFallback',
  'modelRole',
  'durationMs',
  'requests',
  'tokens',
  'cost',
  'contextTokens',
  'contextWindow',
  'retryState',
  'retryFailure',
  'lastIntent',
  'currentTool',
  'toolCount',
  'recentTools'
]

function pickTelemetry(source: Record<string, unknown>): SubagentTelemetry {
  const out: Record<string, unknown> = {}
  for (const key of TELEMETRY_KEYS) {
    const value = source[key]
    if (value !== undefined) out[key] = value
  }
  return out as SubagentTelemetry
}

/**
 * Sparse-safe merge: an omitted / undefined incoming field preserves the
 * existing value; only explicit values overwrite. This is the "missing ≠ clear"
 * rule — a sparse roster snapshot must not erase live progress telemetry.
 */
function mergeDefinedFields(existing: AgentNode | undefined, incoming: AgentNode): AgentNode {
  const out: AgentNode = { ...(existing ?? ({} as AgentNode)) }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

function toAgentNode(event: Extract<SessionEvent, { type: 'subagent' }>, now: number): AgentNode {
  return {
    id: event.id,
    agent: event.agent,
    agentSource: event.agentSource,
    status: normalizeOmpAgentStatus(event.status),
    description: event.description,
    task: event.task,
    assignment: event.assignment,
    sessionFile: event.sessionFile,
    parentToolCallId: event.parentToolCallId,
    index: event.index,
    lastUpdate: now,
    ...pickTelemetry(event as unknown as Record<string, unknown>)
  }
}

function upsertAgent(
  state: ExecutionProjection,
  incoming: AgentNode,
  now: number,
  source: 'live' | 'historical' = 'live'
): ExecutionProjection {
  const existing = state.agents[incoming.id]
  const historical = source === 'historical'
  const startedAt = historical ? incoming.startedAt : existing?.startedAt ?? incoming.startedAt ?? now
  const endedAt = historical
    ? incoming.endedAt
    : isTerminalAgent(incoming.status)
      ? existing?.endedAt ?? incoming.endedAt ?? now
      : existing?.endedAt ?? incoming.endedAt
  const status = historical && incoming.status === 'unknown' && existing ? existing.status : incoming.status
  const node = mergeDefinedFields(existing, { ...incoming, status, startedAt, endedAt })
  return {
    ...state,
    agents: { ...state.agents, [incoming.id]: node }
  }
}

/**
 * Upsert a `get_subagents` roster snapshot. Uses the SAME `upsertAgent` reducer
 * as live events, so snapshot hydration and incremental events converge on one
 * graph — never two state machines. Terminal agents that only existed before the
 * GUI attached are simply absent from the roster (upstream drops them).
 */
export function applyAgentRoster(
  state: ExecutionProjection,
  snapshots: readonly SubagentSnapshot[],
  now = Date.now()
): ExecutionProjection {
  let next = state
  for (const s of snapshots) {
    next = upsertAgent(next, snapshotToAgentNode(s, now), now)
  }
  return next
}

function snapshotToAgentNode(s: SubagentSnapshot, now: number): AgentNode {
  return {
    id: s.id,
    agent: s.agent,
    agentSource: s.agentSource,
    status: normalizeOmpAgentStatus(s.status),
    description: s.description,
    task: s.task,
    assignment: s.assignment,
    sessionFile: s.sessionFile,
    parentToolCallId: s.parentToolCallId,
    index: s.index,
    lastUpdate: s.lastUpdate,
    startedAt: now,
    ...pickTelemetry((s.progress ?? {}) as Record<string, unknown>)
  }
}

/**
 * Upsert durable historical agents (reconstructed from OMP task results,
 * async-result delivery, and child session artifacts)
 * through the SAME `upsertAgent` reducer. Live roster/events override history
 * for CURRENT status field-wise, while history supplies the completed/failed/
 * aborted children that the live `get_subagents` roster no longer reports.
 * Historical hydration never creates arrival-time timestamps; only durable
 * timestamps supplied by the runtime are retained.
 */
export function applyHistoricalAgents(
  state: ExecutionProjection,
  records: readonly HistoricalAgentRecord[],
  now = Date.now()
): ExecutionProjection {
  let next = state
  for (const r of records) {
    next = upsertAgent(next, historicalToAgentNode(r), now, 'historical')
  }
  return next
}

function historicalToAgentNode(r: HistoricalAgentRecord): AgentNode {
  return {
    id: r.id,
    agent: r.agent,
    agentSource: r.agentSource,
    status: normalizeOmpAgentStatus(r.status),
    index: r.index,
    task: r.task,
    assignment: r.assignment,
    description: r.description,
    lastIntent: r.lastIntent,
    resolvedModel: r.resolvedModel,
    resolvedModelIsFallback: r.resolvedModelIsFallback,
    modelRole: r.modelRole,
    durationMs: r.durationMs,
    tokens: r.tokens,
    requests: r.requests,
    contextTokens: r.contextTokens,
    contextWindow: r.contextWindow,
    cost: r.cost,
    resultSummary: r.resultSummary,
    startedAt: r.startedAt,
    endedAt: r.endedAt
  }
}

// ------------------------------------------------------------------ selectors

/** The current (in-flight) turn, or undefined. */
export function currentTurn(projection: ExecutionProjection): TurnProjection | undefined {
  return projection.currentTurnId ? projection.turns[projection.currentTurnId] : undefined
}

/** The most recently COMPLETED turn, or undefined. */
export function lastTurn(projection: ExecutionProjection): TurnProjection | undefined {
  for (let i = projection.turnOrder.length - 1; i >= 0; i--) {
    const turn = projection.turns[projection.turnOrder[i]]
    if (turn && turn.status !== 'running') return turn
  }
  return undefined
}

/** Elapsed wall time of a turn (arrival-based; non-durable across resume). */
export function turnElapsedMs(turn: TurnProjection): number {
  const start = turn.startedAt ?? turn.endedAt ?? 0
  const end = turn.endedAt ?? start
  return Math.max(0, end - start)
}

// ------------------------------------------------------- presentation selectors
// These map the authoritative ToolStats onto the legacy chat-row shapes. They
// are SELECTORS ONLY — no separate persisted counters. TurnRow derives its live
// progress and frozen summary through them.

/** Legacy chat-row verb buckets. */
export type TurnVerb = 'read' | 'search' | 'run' | 'edit' | 'call'

export interface TurnCounts {
  filesRead: number
  searches: number
  commands: number
  edits: number
  toolCalls: number
}

export interface TurnActivity {
  startedAt: number
  counts: TurnCounts
  lastAction?: { verb: TurnVerb; target: string }
}

export interface TurnSummary {
  elapsedMs: number
  counts: TurnCounts
}

export function emptyTurnCounts(): TurnCounts {
  return { filesRead: 0, searches: 0, commands: 0, edits: 0, toolCalls: 0 }
}

/** Map the single classifier onto the legacy chat-row verb. */
export function classifyTool(tool: string): TurnVerb {
  switch (classifyToolCall(tool)) {
    case 'read':
      return 'read'
    case 'search':
      return 'search'
    case 'command':
      return 'run'
    case 'edit':
      return 'edit'
    case 'subagent':
    case 'other':
    default:
      return 'call'
  }
}

/** Map the authoritative ToolStats onto the legacy TurnCounts shape. */
export function toTurnCounts(tools: ToolStats): TurnCounts {
  return {
    filesRead: tools.read,
    searches: tools.search,
    commands: tools.command,
    edits: tools.edit,
    toolCalls: tools.subagent + tools.other
  }
}

/** Live progress for the in-flight turn, in the legacy TurnRow shape. */
export function turnActivityFor(projection: ExecutionProjection): TurnActivity | undefined {
  const turn = currentTurn(projection)
  if (!turn || turn.startedAt === undefined) return undefined
  return {
    startedAt: turn.startedAt,
    counts: toTurnCounts(turn.tools),
    lastAction: turn.lastAction
      ? { verb: classifyTool(turn.lastAction.tool), target: turn.lastAction.target }
      : undefined
  }
}

/** Frozen summary of the last completed turn, in the legacy TurnRow shape. */
export function turnSummaryFor(projection: ExecutionProjection): TurnSummary | undefined {
  const turn = lastTurn(projection)
  if (!turn) return undefined
  return { elapsedMs: turnElapsedMs(turn), counts: toTurnCounts(turn.tools) }
}
