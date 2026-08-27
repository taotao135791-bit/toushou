import path from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import {
  ChatMessage,
  ExtensionUiAnswer,
  PermissionMode,
  PromptImage,
  Session,
  SessionEvent,
  SessionState,
  SessionStats,
  SlashCommand,
  StreamingBehavior,
  SessionThinkingLevel,
  SubagentMessagesResult,
  SubagentSnapshot,
  SubagentTranscriptSelector,
  RpcOutcome,
  HistoricalAgentRecord
} from '../../shared/types'
import { getStore, rememberRecentProject } from '../store'
import { AgentMessage, mapAgentMessages } from '../messageMapping'
import { reconstructSessionMetadata, reconstructHistoricalAgents } from '../sessionMetadata'
import { isSessionFilePath } from '../sessionHistory'
import { planSpawn, removeApprovalConfig, resolvePermissionMode, spawnProcess, writeApprovalConfig } from './OmpProcess'
import { OmpSession } from './OmpSession'
import { extensionExternalLinkMessage } from './extensionLinks'
import {
  detectCli,
  noteHandshake,
  noteSessionState,
  noteSubagentCapabilityOutcome
} from './OmpCapabilities'

/**
 * Facade over the omp session modules (OmpProcess / OmpTransport /
 * OmpHandshake / OmpProtocol / OmpSession / OmpCapabilities). Keeps the
 * exact function surface the old monolithic omp.ts exposed, so ipc.ts and
 * the other consumers (notify, piModels, piSettings) import unchanged from
 * './omp'.
 */

export {
  detectCli,
  invalidateCliCache,
  executableSearchDirs,
  getCapabilities
} from './OmpCapabilities'
export { drainLines } from './OmpTransport'

const sessions = new Map<string, OmpSession>()

export function listSessions(): Session[] {
  return Array.from(sessions.values()).map((s) => s.session)
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId)?.session
}

/** Assistant text produced by the session's last completed turn ('' if none). */
export function getLastAssistantText(sessionId: string): string {
  return sessions.get(sessionId)?.lastAssistantText ?? ''
}

export function createSession(
  cwd: string,
  onEvent: (event: SessionEvent) => void,
  opts?: { resumeSessionPath?: string; modelSelector?: string; thinkingLevel?: SessionThinkingLevel }
): Session {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cli = detectCli()

  if (!cli.available) {
    const errorEvent: SessionEvent = {
      type: 'error',
      sessionId: id,
      message: 'Oh My Pi (omp) or Pi CLI not found. Please install omp first: https://omp.sh'
    }
    setTimeout(() => onEvent(errorEvent), 0)
    return {
      id,
      cwd,
      title: 'Uninitialized',
      createdAt: Date.now(),
      status: 'error'
    }
  }

  const plan = planSpawn(id, cli, {
    permissionMode: getStore('permissionMode'),
    language: getStore('language'),
    resumeSessionPath: opts?.resumeSessionPath,
    modelSelector: opts?.modelSelector,
    thinkingLevel: opts?.thinkingLevel
  })
  // A stale recent-project entry (e.g. a cleaned /tmp dir) would otherwise
  // surface as a misleading "spawn omp ENOENT" — say what actually happened.
  if (!existsSync(cwd)) {
    removeApprovalConfig(id)
    const errorEvent: SessionEvent = {
      type: 'error',
      sessionId: id,
      message: `Project folder does not exist: ${cwd}`,
      recoverable: false
    }
    setTimeout(() => onEvent(errorEvent), 0)
    return {
      id,
      cwd,
      title: 'Missing folder',
      createdAt: Date.now(),
      status: 'error'
    }
  }
  const proc = spawnProcess(plan, cwd)

  const session: Session = {
    id,
    cwd,
    title: path.basename(cwd) || 'New Chat',
    createdAt: Date.now(),
    status: 'idle',
    ...(opts?.resumeSessionPath ? { resumeFrom: opts.resumeSessionPath } : {})
  }

  sessions.set(
    id,
    new OmpSession(session, proc, {
      label: cli.command,
      onEvent,
      onGone: () => sessions.delete(id),
      onHandshake: (outcome) => {
        noteHandshake(outcome)
        // Current Oh My Pi: enable subagent progress subscription + roster
        // hydration once the profile is confirmed. A subscription failure never
        // fails the session — subagent capability just stays unknown/unsupported.
        if (outcome.profile === 'current') {
          const entry = sessions.get(id)
          if (entry) void bootstrapSubagentBridge(entry)
        }
      },
      onOpenUrl: (url, launchUrl, instructions) => {
        // Third-party extensions must never open a browser without a user
        // gesture. Surface a safe, explicit link in the transcript instead.
        const content = extensionExternalLinkMessage(url, launchUrl, instructions)
        if (content) {
          onEvent({ type: 'message', sessionId: id, role: 'system', content })
        } else {
          onEvent({
            type: 'error',
            sessionId: id,
            message: 'Extension requested an invalid external URL.',
            recoverable: true
          })
        }
      },
      onDebug: (message) => {
        if (!app.isPackaged) console.debug(`[omp:${id.slice(-6)}]`, message)
      }
    })
  )

  rememberRecentProject(cwd)

  return session
}

export function sendMessage(
  sessionId: string,
  text: string,
  images?: PromptImage[],
  streamingBehavior?: StreamingBehavior
): boolean {
  return sessions.get(sessionId)?.sendPrompt(text, images, streamingBehavior) ?? false
}

export function killSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId)
  if (!entry) return false
  // kill() closes the session and drops it from the registry via onGone.
  entry.kill()
  // Drop the per-session approval config alongside the process.
  removeApprovalConfig(sessionId)
  return true
}

export function abortSession(sessionId: string): boolean {
  return sessions.get(sessionId)?.abort() ?? false
}

/** Answer (or cancel) a pending extension UI dialog for a session. */
export function respondExtensionUi(
  sessionId: string,
  requestId: string,
  answer: ExtensionUiAnswer
): boolean {
  return sessions.get(sessionId)?.respondExtensionUi(requestId, answer) ?? false
}

/** Hot-switch the model of a live session via the RPC set_model command. */
export function setSessionModel(sessionId: string, provider: string, modelId: string): boolean {
  return sessions.get(sessionId)?.setModel(provider, modelId) ?? false
}

/**
 * Fetch the live subagent roster (`get_subagents`) and record the capability.
 * Null when the session is missing or the roster command is unsupported; a
 * supported-but-failed call still records `subagents` as supported.
 */
export async function getSubagents(sessionId: string): Promise<SubagentSnapshot[] | null> {
  const outcome = await (sessions.get(sessionId)?.getSubagents() ??
    Promise.resolve<RpcOutcome<SubagentSnapshot[]>>({ kind: 'unknown' }))
  noteSubagentCapabilityOutcome('subagents', outcome)
  return outcome.kind === 'success' ? outcome.data : null
}

/**
 * Incrementally read a child agent transcript (`get_subagent_messages`). The
 * transcript is NOT merged into the root transcript — it is a separate
 * conversation surfaced only when the user opens the child. Null on failure;
 * a "not found" error records `subagentMessages` as supported (the command
 * exists), only `Unknown command:` records it unsupported.
 */
export async function getSubagentMessages(
  sessionId: string,
  selector: SubagentTranscriptSelector
): Promise<SubagentMessagesResult | null> {
  const outcome = await (sessions.get(sessionId)?.getSubagentMessages(selector) ??
    Promise.resolve<RpcOutcome<SubagentMessagesResult>>({ kind: 'unknown' }))
  noteSubagentCapabilityOutcome('subagentMessages', outcome)
  return outcome.kind === 'success' ? outcome.data : null
}

/**
 * Post-handshake bootstrap for a Current-Oh-My-Pi session: enable the
 * `progress` subscription and record the real capability. The roster is NOT
 * fetched here — the renderer hydrates it once via `getSubagents()` on session
 * attach, so there is no duplicate bootstrap request. A rejected subscription
 * leaves the session usable (subagent capability stays unknown/unsupported).
 */
async function bootstrapSubagentBridge(session: OmpSession): Promise<void> {
  const outcome = await session.setSubagentSubscription('progress')
  noteSubagentCapabilityOutcome('subagentProgress', outcome)
}

/**
 * Send an RPC command and await its response, matched by request id.
 * Resolves null on timeout, missing session, or process exit.
 */
function querySession(
  sessionId: string,
  command: Record<string, unknown>,
  timeoutMs = 8000
): Promise<Record<string, unknown> | null> {
  return sessions.get(sessionId)?.query(command, timeoutMs) ?? Promise.resolve(null)
}

/** Token/context usage for the usage monitor. */
export async function getSessionStats(sessionId: string): Promise<SessionStats | null> {
  const res = await querySession(sessionId, { type: 'get_session_stats' })
  if (!res || res.success !== true || !res.data) return null
  return res.data as SessionStats
}

/** Slash commands available in this session (extensions, prompts, skills). */
export async function listSessionCommands(sessionId: string): Promise<SlashCommand[]> {
  // Current Oh My Pi renamed the command (get_commands →
  // get_available_commands); probe the new name first and fall back for
  // legacy runtimes. Both answer `{commands: [...]}`.
  let res = await querySession(sessionId, { type: 'get_available_commands' })
  if (!res || res.success !== true) {
    res = await querySession(sessionId, { type: 'get_commands' })
  }
  if (!res || res.success !== true || !res.data) return []
  const raw = (res.data as { commands?: unknown }).commands
  if (!Array.isArray(raw)) return []
  const out: SlashCommand[] = []
  for (const c of raw) {
    const cmd = c as { name?: unknown; description?: unknown; source?: unknown }
    if (typeof cmd?.name !== 'string') continue
    out.push({
      name: cmd.name,
      description: typeof cmd.description === 'string' ? cmd.description : undefined,
      source: cmd.source === 'extension' || cmd.source === 'skill' ? cmd.source : 'prompt'
    })
  }
  return out
}

/** Trigger context compaction; the summarization LLM call can take a while. */
export async function compactSession(sessionId: string): Promise<boolean> {
  const res = await querySession(sessionId, { type: 'compact' }, 120_000)
  return Boolean(res && res.success === true)
}

/** Inject a steering message into a running turn. */
export async function steer(
  sessionId: string,
  message: string,
  images?: PromptImage[]
): Promise<boolean> {
  const res = await querySession(sessionId, {
    type: 'steer',
    message,
    ...(images?.length ? { images } : {})
  })
  return Boolean(res && res.success === true)
}

/** Queue a follow-up message, delivered after the current turn finishes. */
export async function followUp(
  sessionId: string,
  message: string,
  images?: PromptImage[]
): Promise<boolean> {
  const res = await querySession(sessionId, {
    type: 'follow_up',
    message,
    ...(images?.length ? { images } : {})
  })
  return Boolean(res && res.success === true)
}

/** Change the thinking level of a live session. */
export async function setThinkingLevel(sessionId: string, level: SessionThinkingLevel): Promise<boolean> {
  const res = await querySession(sessionId, { type: 'set_thinking_level', level })
  return Boolean(res && res.success === true)
}

/**
 * Rewrite the approval extension config of a live session. The extension
 * re-reads the file (mtime-cached) on every tool call, so 'ask' ↔ 'off'
 * flips apply mid-session. no-bash/readonly are spawn-time tool exclusions
 * (--exclude-tools / --tools) with no live equivalent — writing their
 * approval config (inert 'off') would silently turn a restricted session
 * into full auto-approve, so they are refused here.
 */
export function updateApprovalConfig(sessionId: string, mode: PermissionMode): boolean {
  const entry = sessions.get(sessionId)
  if (!entry) return false
  if (mode !== 'ask' && mode !== 'full') return false
  const { approval } = resolvePermissionMode(mode)
  writeApprovalConfig(sessionId, approval)
  return true
}

/** Export the session transcript as HTML; resolves the saved file path. */
export async function exportHtml(sessionId: string, outputPath?: string): Promise<string | null> {
  const res = await querySession(
    sessionId,
    { type: 'export_html', ...(outputPath ? { outputPath } : {}) },
    30_000
  )
  if (!res || res.success !== true || !res.data) return null
  const saved = (res.data as { path?: unknown }).path
  return typeof saved === 'string' ? saved : null
}

/** Live session state from the RPC get_state command. */
export async function getSessionState(sessionId: string): Promise<SessionState | null> {
  const res = await querySession(sessionId, { type: 'get_state' })
  if (!res || res.success !== true || !res.data) return null
  const state = res.data as SessionState
  // A live get_state response doubles as the runtime capability probe.
  noteSessionState(state)
  return state
}

/** Full transcript of a session, mapped to GUI chat messages (get_messages). */
export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await querySession(sessionId, { type: 'get_messages' }, 15_000)
  if (!res || res.success !== true || !res.data) return []
  const raw = (res.data as { messages?: unknown }).messages
  if (!Array.isArray(raw)) return []
  return mapAgentMessages(raw as AgentMessage[])
}

/** Set the session display name (single line, truncated to 60 chars). */
export async function setSessionName(sessionId: string, name: string): Promise<boolean> {
  const clean = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
  if (!clean) return false
  const res = await querySession(sessionId, { type: 'set_session_name', name: clean })
  return Boolean(res && res.success === true)
}

/**
 * Resume a persisted session file as a new live session and return it together
 * with its transcript in one round-trip. Returns null when the path is not a
 * session file under the sessions root, or when the CLI is unavailable.
 */
export async function resumeSession(
  cwd: string,
  onEvent: (event: SessionEvent) => void,
  filePath: string
): Promise<{ session: Session; messages: ChatMessage[]; historicalAgents: HistoricalAgentRecord[] } | null> {
  if (!isSessionFilePath(filePath)) return null
  const session = createSession(cwd, onEvent, { resumeSessionPath: filePath })
  if (session.status === 'error') return null
  const messages = await getSessionMessages(session.id)
  // Reconstruct per-turn model/thinking from the durable session JSONL and tag
  // each user message. Steer kind is already set by mapAgentMessages from the
  // `steering` flag. Unknown (unrecorded) metadata stays unknown — never guessed.
  const metadata = await reconstructSessionMetadata(filePath)
  let metaIndex = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    const meta = metadata[metaIndex++]
    if (!meta) break
    if (meta.model !== undefined) message.runtimeModel = meta.model
    if (meta.thinking !== undefined) message.runtimeThinking = meta.thinking
  }
  // Reconstruct historical children from durable task results, async-result
  // delivery, and child session artifacts, so a resumed session shows its
  // agent history even though the live roster is empty. Running state is NEVER
  // claimed from a stale durable progress snapshot.
  const historicalAgents = await reconstructHistoricalAgents(filePath)
  return { session, messages, historicalAgents }
}
