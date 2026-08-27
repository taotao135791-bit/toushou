import { ExtensionUiAnswer, SessionEvent } from '../../shared/types'
import { safeExtensionExternalUrl } from './extensionLinks'

/**
 * Semantic normalization for pi/omp `--mode rpc` frames: raw RPC objects in,
 * GUI session events out. Both runtime profiles are mapped onto the same
 * event surface so the renderer never sees protocol versions or renames:
 *
 *   legacy Pi ≤0.84            current Oh My Pi            normalized
 *   ───────────────────────    ─────────────────────────   ─────────────────
 *   compaction_start/end       auto_compaction_start/end   compaction
 *   (local cmds go to agent)   command_output              system message
 *                              auto_retry_start            system message
 *                              retry_fallback_applied      system message
 *   agent_end                  agent_end (+isTerminal?)    status idle/working
 *
 * Verified against pi 0.80.3 and omp 17.2.12 (docs/protocol-facts.md):
 * - Commands (stdin):   { id?, type: 'prompt', message: string, images? }
 * - Responses (stdout): { type: 'response', command, success, data | error, code? }
 * - Tool events carry a stable `toolCallId` and may run concurrently —
 *   match call/result pairs by id, never by name+recency.
 * - `agent_end` without an explicit `isTerminal: false` is turn-terminal.
 * - Extension UI:       { type: 'extension_ui_request', id, method, ... }
 *   - select:  title, options[], timeout?
 *   - confirm: title, message, timeout?
 *   - input:   title, placeholder?, timeout?
 *   - editor:  title, prefill?
 *   - cancel:  targetId — dismisses a pending interactive dialog
 *   - open_url: url, launchUrl?, instructions? — host presents a user-mediated browser link
 *   - notify / setStatus / setWidget / setTitle / set_editor_text: no response
 * - Unknown frames are ignored by design (forward compatibility), but the
 *   discriminators we do read (`type`, ids) are always validated.
 *
 * Pure functions so they can be unit-tested without Electron.
 */

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor'

/**
 * Untrusted extensions can send UI frames while a session is running. Keep
 * their presentation payloads bounded before they ever reach renderer state.
 * These are deliberately generous enough for an editor request while still
 * preventing one malformed extension from allocating an unbounded dialog.
 */
export const EXTENSION_UI_LIMITS = {
  requestId: 200,
  title: 2_000,
  message: 16_000,
  optionCount: 100,
  option: 2_000,
  prefill: 64_000,
  timeoutMs: 24 * 60 * 60 * 1_000
} as const

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined
}

function validExtensionRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EXTENSION_UI_LIMITS.requestId &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

function boundedOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((option): option is string => typeof option === 'string')
    .slice(0, EXTENSION_UI_LIMITS.optionCount)
    .map((option) => option.slice(0, EXTENSION_UI_LIMITS.option))
}

function boundedTimeout(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= EXTENSION_UI_LIMITS.timeoutMs
    ? Math.floor(value)
    : undefined
}

/**
 * Tool results arrive structured: `{content: [{type:'text', text}, ...]}`.
 * Renderers want text — extract the text blocks; fall back to a compact
 * JSON string for shapes we don't know (never "[object Object]").
 */
export function extractToolOutput(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c && typeof c === 'object' ? (c as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
      if (text) return text
    }
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }
  return String(result)
}

export type RpcParseResult =
  | { kind: 'event'; event: SessionEvent }
  /** Interactive extension UI request — the host should answer or cancel it */
  | {
      kind: 'extension_ui'
      id: string
      method: ExtensionUiMethod
      title: string
      message?: string
      options?: string[]
      placeholder?: string
      prefill?: string
      timeout?: number
    }
  /** An extension dismissed a pending interactive dialog (method: cancel). */
  | { kind: 'extension_ui_cancel'; targetId: string }
  /** A malformed extension UI request was rejected before it could block a turn. */
  | { kind: 'extension_ui_invalid'; reason: string }
  /** Upstream asked for host UI functionality the desktop host does not implement. */
  | { kind: 'extension_ui_unsupported'; method: string }
  /** The runtime asks the host to open a URL in the system browser. */
  | { kind: 'open_url'; url: string; launchUrl?: string; instructions?: string }
  /**
   * Deferred outcome of a prompt command: the agent was not invoked and the
   * prompt completed locally without agent_start/agent_end.
   */
  | { kind: 'prompt_result'; id?: string; agentInvoked: boolean }
  /**
   * A failed RPC command response that no pending query claimed. Surfacing
   * it as an error event is the session's call — the parser only reports.
   */
  | { kind: 'command_failed'; id?: string; command?: string; message: string; code?: string }
  /** Frame consumed (or deliberately ignored), nothing to surface */
  | { kind: 'none' }

function systemMessage(sessionId: string, content: string): RpcParseResult {
  return {
    kind: 'event',
    event: { type: 'message', sessionId, role: 'system', content }
  }
}

/**
 * Normalize one parsed RPC object. Frames not claimed by the session's
 * bookkeeping (pending queries, prompt tracking, the handshake) arrive here.
 */
export function normalizeRpcFrame(
  payload: Record<string, unknown>,
  sessionId: string
): RpcParseResult {
  switch (payload.type) {
    case 'response': {
      if (payload.success === false) {
        return {
          kind: 'command_failed',
          id: typeof payload.id === 'string' ? payload.id : undefined,
          command: typeof payload.command === 'string' ? payload.command : undefined,
          message: String(payload.error ?? 'Unknown RPC error'),
          code: typeof payload.code === 'string' ? payload.code : undefined
        }
      }
      return { kind: 'none' }
    }

    // Deferred prompt outcome (current runtime): a prompt that completed
    // locally produces no agent events; the session needs this to settle
    // the turn without waiting for an agent_end that never comes.
    case 'prompt_result':
      return {
        kind: 'prompt_result',
        id: typeof payload.id === 'string' ? payload.id : undefined,
        agentInvoked: payload.agentInvoked === true
      }

    // Output of a locally executed slash command (current runtime). Legacy
    // pi forwards slash commands to the agent instead, so this is the only
    // channel through which their result is visible at all.
    case 'command_output':
      return systemMessage(sessionId, String(payload.text ?? ''))

    case 'message_update': {
      const ev = payload.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
        return {
          kind: 'event',
          event: { type: 'message', sessionId, role: 'assistant', content: ev.delta }
        }
      }
      if (ev?.type === 'thinking_delta' && typeof ev.delta === 'string') {
        return {
          kind: 'event',
          event: { type: 'thinking', sessionId, delta: ev.delta }
        }
      }
      return { kind: 'none' }
    }

    case 'message_end': {
      // Provider/transport failures don't produce an error event and the
      // process exits 0 regardless — the failure only shows up as
      // stopReason:'error' with errorMessage on the final assistant message.
      // Surface it or the user sees a silent dead turn.
      const msg = payload.message as
        | { role?: string; stopReason?: string; errorMessage?: string }
        | undefined
      if (msg?.role === 'assistant' && msg.stopReason === 'error' && msg.errorMessage) {
        return {
          kind: 'event',
          event: {
            type: 'error',
            sessionId,
            // First line only — provider errors often append a raw JSON body.
            message: msg.errorMessage.split('\n')[0].slice(0, 300)
          }
        }
      }
      return { kind: 'none' }
    }

    case 'tool_execution_start':
      return {
        kind: 'event',
        event: {
          type: 'tool_call',
          sessionId,
          id: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
          tool: String(payload.toolName ?? 'tool'),
          input: payload.args
        }
      }

    case 'tool_execution_update':
      // partialResult streaming — noise for the GUI; the final result arrives
      // via tool_execution_end.
      return { kind: 'none' }

    case 'tool_execution_end':
      return {
        kind: 'event',
        event: {
          type: 'tool_result',
          sessionId,
          id: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
          tool: String(payload.toolName ?? 'tool'),
          output: extractToolOutput(payload.result),
          isError: Boolean(payload.isError)
        }
      }

    case 'extension_ui_request': {
      const method = typeof payload.method === 'string' ? payload.method : ''
      if (method === 'cancel') {
        return validExtensionRequestId(payload.targetId)
          ? { kind: 'extension_ui_cancel', targetId: payload.targetId }
          : { kind: 'extension_ui_invalid', reason: 'The extension sent an invalid dialog cancellation.' }
      }
      if (method === 'open_url') {
        const url = safeExtensionExternalUrl(payload.url)
        return url
          ? {
              kind: 'open_url',
              url,
              launchUrl: safeExtensionExternalUrl(payload.launchUrl) ?? undefined,
              instructions: boundedText(payload.instructions, EXTENSION_UI_LIMITS.message)
            }
          : { kind: 'extension_ui_invalid', reason: 'The extension requested an invalid external URL.' }
      }
      if (method === 'notify') {
        return systemMessage(sessionId, boundedText(payload.message, EXTENSION_UI_LIMITS.message) ?? '')
      }
      if (
        method === 'select' ||
        method === 'confirm' ||
        method === 'input' ||
        method === 'editor'
      ) {
        if (!validExtensionRequestId(payload.id)) {
          return { kind: 'extension_ui_invalid', reason: 'The extension sent a dialog without a valid id.' }
        }
        // Interactive requests need a response from the user
        return {
          kind: 'extension_ui',
          id: payload.id,
          method,
          title: boundedText(payload.title, EXTENSION_UI_LIMITS.title) ?? '',
          message: boundedText(payload.message, EXTENSION_UI_LIMITS.message),
          options: boundedOptions(payload.options),
          placeholder: boundedText(payload.placeholder, EXTENSION_UI_LIMITS.title),
          prefill: boundedText(payload.prefill, EXTENSION_UI_LIMITS.prefill),
          timeout: boundedTimeout(payload.timeout)
        }
      }
      return {
        kind: 'extension_ui_unsupported',
        method: method.slice(0, 100) || 'unknown'
      }
    }

    case 'extension_error':
      return {
        kind: 'event',
        event: {
          type: 'error',
          sessionId,
          message: `Extension error: ${String(payload.error ?? 'unknown')}`
        }
      }

    case 'agent_start':
      return {
        kind: 'event',
        event: { type: 'status', sessionId, status: 'working' }
      }

    case 'agent_end':
      return {
        kind: 'event',
        event: {
          type: 'status',
          sessionId,
          status: 'idle',
          // Absent means terminal; only an explicit upstream false marks a
          // non-terminal end (async delivery will resume the session).
          isTerminal: payload.isTerminal === false ? false : true
        }
      }

    // Compaction: legacy names and current names normalize to one event.
    case 'compaction_start':
    case 'auto_compaction_start':
      return {
        kind: 'event',
        event: { type: 'compaction', sessionId, phase: 'start' }
      }

    case 'compaction_end':
    case 'auto_compaction_end':
      return {
        kind: 'event',
        event: { type: 'compaction', sessionId, phase: 'end' }
      }

    // Provider auto-retry: one informational line per attempt, not a stream
    // of raw errors. A final failure ends the turn via message_end (above),
    // so auto_retry_end needs no mapping either way.
    case 'auto_retry_start': {
      const attempt = typeof payload.attempt === 'number' ? payload.attempt : undefined
      const max = typeof payload.maxAttempts === 'number' ? payload.maxAttempts : undefined
      const reason =
        typeof payload.errorMessage === 'string'
          ? payload.errorMessage.split('\n')[0].slice(0, 200)
          : ''
      const progress = attempt !== undefined && max !== undefined ? ` (${attempt}/${max})` : ''
      return systemMessage(sessionId, `Retrying${progress}… ${reason}`.trim())
    }

    case 'retry_fallback_applied':
      return systemMessage(
        sessionId,
        `Model fallback: ${String(payload.from ?? '?')} → ${String(payload.to ?? '?')}`
      )

    case 'retry_fallback_succeeded':
    case 'auto_retry_end':
      return { kind: 'none' }

    // The runtime resolved a thinking-level change — carries the RESOLVED
    // level (requested values may be clamped to what the model supports);
    // absent thinkingLevel means "auto". This is the display source of truth.
    case 'thinking_level_changed':
      return {
        kind: 'event',
        event: {
          type: 'thinking_level_changed',
          sessionId,
          level: typeof payload.thinkingLevel === 'string' ? payload.thinkingLevel : undefined
        }
      }

    // The session's model changed (set_model, fallback); the renderer
    // refetches get_state for the full model object.
    case 'model_changed':
      return { kind: 'event', event: { type: 'model_changed', sessionId } }

    // Runtime notices: warnings/errors are user-relevant; info is MCP-mount
    // chatter that would pollute the chat.
    case 'notice':
      if (payload.level === 'warning' || payload.level === 'error') {
        return systemMessage(sessionId, String(payload.message ?? ''))
      }
      return { kind: 'none' }

    // ----------------------------------------------------------------- subagents
    // Current Oh My Pi exposes the subagent graph via `subagent_lifecycle` and
    // `subagent_progress` frames (gated by `set_subagent_subscription`, default
    // off). Both normalize onto the SAME `subagent` event — lifecycle carries
    // the phase (started → 'running', completed/failed/aborted), progress
    // carries aggregated task/tool facts. `subagent_event` (raw child-session
    // events) only fires at subscription level 'events'; the GUI subscribes at
    // 'progress', so it is deliberately not projected. Status mapping is EXACT
    // (no substring guessing): `AgentProgress.status` / lifecycle phase only.
    case 'subagent_lifecycle': {
      const p = asRecord(payload.payload)
      const id = asString(p.id)
      const status = normalizeSubagentStatus(p.status)
      if (!id || !status) return { kind: 'none' }
      return {
        kind: 'event',
        event: {
          type: 'subagent',
          sessionId,
          id,
          agent: asString(p.agent) ?? '',
          agentSource: asAgentSource(p.agentSource) ?? 'bundled',
          description: asString(p.description),
          status,
          phase: asLifecyclePhase(p.status),
          sessionFile: asString(p.sessionFile),
          parentToolCallId: asString(p.parentToolCallId),
          index: asNumber(p.index),
          detached: p.detached === true ? true : undefined
        }
      }
    }

    case 'subagent_progress': {
      const p = asRecord(payload.payload)
      const progress = asRecord(p.progress)
      const id = asString(progress.id)
      const status = normalizeSubagentStatus(progress.status)
      if (!id || !status) return { kind: 'none' }
      return {
        kind: 'event',
        event: {
          type: 'subagent',
          sessionId,
          id,
          agent: asString(p.agent) ?? '',
          agentSource: asAgentSource(p.agentSource) ?? 'bundled',
          description: asString(progress.description),
          status,
          task: asString(p.task),
          assignment: asString(p.assignment),
          sessionFile: asString(p.sessionFile),
          parentToolCallId: asString(p.parentToolCallId),
          index: asNumber(p.index),
          detached: p.detached === true ? true : undefined,
          lastIntent: asString(progress.lastIntent),
          currentTool: asString(progress.currentTool),
          toolCount: asNumber(progress.toolCount),
          resolvedModel: asString(progress.resolvedModel),
          resolvedModelIsFallback: progress.resolvedModelIsFallback === true ? true : undefined,
          modelRole: asString(progress.modelRole),
          durationMs: asNumber(progress.durationMs),
          requests: asNumber(progress.requests),
          tokens: asNumber(progress.tokens),
          cost: asNumber(progress.cost),
          contextTokens: asNumber(progress.contextTokens),
          contextWindow: asNumber(progress.contextWindow),
          retryState: asRecord(progress.retryState) as Extract<
            SessionEvent,
            { type: 'subagent' }
          >['retryState'],
          retryFailure: asRecord(progress.retryFailure) as Extract<
            SessionEvent,
            { type: 'subagent' }
          >['retryFailure'],
          recentTools: Array.isArray(progress.recentTools)
            ? (progress.recentTools as Extract<SessionEvent, { type: 'subagent' }>['recentTools'])
            : undefined
        }
      }
    }

    case 'subagent_event':
      // Raw child-session events (only at subscription level 'events'). The GUI
      // never subscribes there — and if it ever does, these stay out of the
      // main renderer stream (child transcripts are read via get_subagent_messages).
      return { kind: 'none' }

    default:
      // Everything else is deliberately not surfaced: turn_*/message_start,
      // session_info_update, config_update, goal_updated, todo_*,
      // ttsr_triggered, irc_message, available_commands_update, host_tool_*,
      // host_uri_* … Unknown future frames land here too —
      // forward compatibility by construction, and the session debug-logs
      // what we skip.
      return { kind: 'none' }
  }
}

/** A string value, or undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A finite number value, or undefined. */
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** An object value, or an empty record. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** An agent-source literal, or undefined (caller supplies a default). */
function asAgentSource(v: unknown): 'bundled' | 'user' | 'project' | undefined {
  return v === 'bundled' || v === 'user' || v === 'project' ? v : undefined
}

/** A lifecycle phase literal, or undefined. */
function asLifecyclePhase(v: unknown): 'started' | 'completed' | 'failed' | 'aborted' | undefined {
  return v === 'started' || v === 'completed' || v === 'failed' || v === 'aborted'
    ? v
    : undefined
}

/**
 * EXACT status normalization. Lifecycle `started` → 'running' (mirrors the
 * upstream `statusFromLifecycle`); the other values are the `AgentProgress`
 * status enum verbatim. Unknown values → undefined (the caller drops the
 * event rather than guessing). No substring matching.
 */
function normalizeSubagentStatus(raw: unknown): 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | undefined {
  switch (raw) {
    case 'started':
      return 'running'
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'aborted':
      return raw
    default:
      return undefined
  }
}

/** Line-oriented wrapper: parse the JSONL frame, then normalize it. */
export function parseRpcLine(line: string, sessionId: string): RpcParseResult {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(line)
  } catch {
    // Not JSON — surface as plain assistant text
    return {
      kind: 'event',
      event: { type: 'message', sessionId, role: 'assistant', content: line }
    }
  }
  return normalizeRpcFrame(payload, sessionId)
}

/** Build a cancel response for an interactive extension UI request. */
export function extensionUiCancel(id: string): string {
  return JSON.stringify({ type: 'extension_ui_response', id, cancelled: true }) + '\n'
}

/** Build the response line for an answered extension UI request. */
export function extensionUiResponse(id: string, answer: ExtensionUiAnswer): string {
  return JSON.stringify({ type: 'extension_ui_response', id, ...answer }) + '\n'
}
