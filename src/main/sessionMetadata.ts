import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { HistoricalAgentRecord, SubagentAgentSource } from '../shared/types'

/**
 * OMP session reconstruction. The session JSONL is an append-only TREE, not a
 * linear chat log: every entry carries `id` / `parentId`, and a rollback/fork
 * appends a new branch whose parent is an earlier entry — so physical file
 * order != the active conversation. Reconstruction must therefore walk the
 * ACTIVE path (leaf -> root via parentId), mirroring OMP's own
 * `buildSessionContext`.
 *
 * Everything here is defensive and forward-compatible: unknown entries are
 * skipped, a corrupt/cyclic parent chain terminates safely (visited set), and a
 * missing parent recovers what it can.
 */

export interface TurnExecutionMetadata {
  /** `provider/modelId` in effect at this user prompt, if recorded. */
  model?: string
  /** Session thinking level in effect at this user prompt, if recorded. */
  thinking?: string
}

interface SessionEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: unknown
  model?: unknown
  role?: unknown
  thinkingLevel?: unknown
  message?: Record<string, unknown>
  customType?: unknown
  details?: unknown
  data?: unknown
  [key: string]: unknown
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

/** Parse a session JSONL string into entries, skipping malformed lines. */
export function parseSessionEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as SessionEntry)
    } catch {
      // skip malformed line
    }
  }
  return entries
}

/**
 * Resolve the active path (leaf -> root, reversed) with cycle protection.
 * The active leaf is the LAST entry — matching OMP's session index, which sets
 * the leaf to the last inserted entry on rebuild.
 */
export function resolveActivePath(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  const leaf = entries.length > 0 ? entries[entries.length - 1] : undefined
  if (!leaf) return []

  const active: SessionEntry[] = []
  const seen = new Set<string>()
  let cursor: SessionEntry | undefined = leaf
  while (cursor && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    active.push(cursor)
    cursor = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) : undefined
  }
  active.reverse()
  return active
}

/** Reconstruct per-turn model/thinking from the active path only. */
export async function reconstructSessionMetadata(sessionFile: string): Promise<TurnExecutionMetadata[]> {
  let text: string
  try {
    text = await readFile(sessionFile, 'utf8')
  } catch {
    return []
  }

  const activePath = resolveActivePath(parseSessionEntries(text))
  const out: TurnExecutionMetadata[] = []
  let currentModel: string | undefined
  let currentThinking: string | undefined

  for (const entry of activePath) {
    if (entry.type === 'model_change') {
      const role = typeof entry.role === 'string' && entry.role ? entry.role : 'default'
      // OMP persists model changes for every semantic role in one session.
      // Only the default role changes the model used by the parent turn.
      if (role === 'default' && typeof entry.model === 'string' && entry.model) {
        currentModel = entry.model
      }
    } else if (entry.type === 'thinking_level_change') {
      // OMP 17.2.12 persists thinking level as a session-wide setting; there is
      // no role field on ThinkingLevelChangeEntry in the pinned upstream schema.
      currentThinking = typeof entry.thinkingLevel === 'string' ? entry.thinkingLevel : undefined
    } else if (entry.type === 'message') {
      if (entry.message?.role === 'user') {
        out.push({ model: currentModel, thinking: currentThinking })
      }
    }
  }

  return out
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asDuration(value: unknown): number | undefined {
  const number = asFiniteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function asTimestamp(value: unknown): number | undefined {
  const number = asFiniteNumber(value)
  if (number !== undefined) return number
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function agentSource(value: unknown): SubagentAgentSource {
  return value === 'user' || value === 'project' ? value : 'bundled'
}

/** Derive a terminal status only from structured runtime fields. */
function statusFromResult(result: JsonRecord): HistoricalAgentRecord['status'] {
  if (result.aborted === true) return 'aborted'
  const exitCode = asFiniteNumber(result.exitCode)
  if (exitCode !== undefined) return exitCode === 0 ? 'completed' : 'failed'
  if (typeof result.error === 'string' && result.error.trim()) return 'failed'
  return 'unknown'
}

function usageRecord(raw: unknown): JsonRecord | undefined {
  return isRecord(raw) ? raw : undefined
}

function usageTokens(usage: JsonRecord | undefined): number | undefined {
  if (!usage) return undefined
  const input = asFiniteNumber(usage.input)
  const output = asFiniteNumber(usage.output)
  const cacheWrite = asFiniteNumber(usage.cacheWrite)
  if (input !== undefined || output !== undefined || cacheWrite !== undefined) {
    return (input ?? 0) + (output ?? 0) + (cacheWrite ?? 0)
  }
  return asFiniteNumber(usage.totalTokens)
}

function usageCost(usage: JsonRecord | undefined): number | undefined {
  return usage && isRecord(usage.cost) ? asFiniteNumber(usage.cost.total) : undefined
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

function summaryFromResult(raw: JsonRecord): string | undefined {
  const output = typeof raw.output === 'string' ? raw.output : undefined
  if (output) return output.slice(0, 200)
  const error = typeof raw.error === 'string' ? raw.error : undefined
  return error ? error.slice(0, 200) : undefined
}

/** Build one historical record from an upstream-shaped `SingleResult`. */
function recordFromResult(raw: JsonRecord): HistoricalAgentRecord | null {
  if (typeof raw.id !== 'string' || !raw.id) return null
  const usage = usageRecord(raw.usage)
  return {
    id: raw.id,
    agent: typeof raw.agent === 'string' ? raw.agent : 'task',
    agentSource: agentSource(raw.agentSource),
    status: statusFromResult(raw),
    source: 'task-result',
    index: asFiniteNumber(raw.index),
    task: typeof raw.task === 'string' ? raw.task : undefined,
    assignment: typeof raw.assignment === 'string' ? raw.assignment : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    lastIntent: typeof raw.lastIntent === 'string' ? raw.lastIntent : undefined,
    resolvedModel: typeof raw.resolvedModel === 'string' ? raw.resolvedModel : undefined,
    resolvedModelIsFallback: raw.resolvedModelIsFallback === true ? true : undefined,
    modelRole: typeof raw.modelRole === 'string' ? raw.modelRole : undefined,
    startedAt: asTimestamp(raw.startedAt),
    endedAt: asTimestamp(raw.endedAt),
    durationMs: asDuration(raw.durationMs),
    tokens: asFiniteNumber(raw.tokens) ?? usageTokens(usage),
    requests: asFiniteNumber(raw.requests),
    contextTokens: asFiniteNumber(raw.contextTokens),
    contextWindow: asFiniteNumber(raw.contextWindow),
    cost: usageCost(usage),
    resultSummary: summaryFromResult(raw)
  }
}

/** Build an identity/telemetry record from an initial `AgentProgress` snapshot. */
function recordFromProgress(raw: JsonRecord): HistoricalAgentRecord | null {
  if (typeof raw.id !== 'string' || !raw.id) return null
  const duration = asDuration(raw.durationMs)
  return {
    id: raw.id,
    agent: typeof raw.agent === 'string' ? raw.agent : 'task',
    agentSource: agentSource(raw.agentSource),
    // AgentProgress.status is a live snapshot, not a durable terminal result.
    // On resume it cannot prove that the child is still running or completed.
    status: 'unknown',
    source: 'task-result',
    index: asFiniteNumber(raw.index),
    task: typeof raw.task === 'string' ? raw.task : undefined,
    assignment: typeof raw.assignment === 'string' ? raw.assignment : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    lastIntent: typeof raw.lastIntent === 'string' ? raw.lastIntent : undefined,
    resolvedModel: typeof raw.resolvedModel === 'string' ? raw.resolvedModel : undefined,
    resolvedModelIsFallback: raw.resolvedModelIsFallback === true ? true : undefined,
    modelRole: typeof raw.modelRole === 'string' ? raw.modelRole : undefined,
    // OMP initializes durationMs to 0 before execution. That is not a measured
    // runtime duration, so omit it until a settled notification.
    durationMs: duration !== undefined && duration > 0 ? duration : undefined,
    tokens: asFiniteNumber(raw.tokens),
    requests: asFiniteNumber(raw.requests),
    contextTokens: asFiniteNumber(raw.contextTokens),
    contextWindow: asFiniteNumber(raw.contextWindow),
    cost: asFiniteNumber(raw.cost)
  }
}

function asyncJobsFromEntry(entry: SessionEntry): JsonRecord[] {
  let customType: unknown
  let details: unknown
  if (entry.type === 'message' && entry.message?.role === 'custom') {
    customType = entry.message.customType
    details = entry.message.details
  } else if (entry.type === 'custom_message') {
    customType = entry.customType
    details = entry.details
  }
  if (customType !== 'async-result' || !isRecord(details) || !Array.isArray(details.jobs)) return []
  return details.jobs.filter(isRecord)
}

function recordFromAsyncJob(raw: JsonRecord, existing?: HistoricalAgentRecord): HistoricalAgentRecord | null {
  if (typeof raw.jobId !== 'string' || !raw.jobId) return null
  const label = typeof raw.label === 'string' && raw.label ? raw.label : undefined
  return {
    id: raw.jobId,
    agent: existing?.agent ?? label ?? 'task',
    agentSource: existing?.agentSource ?? 'bundled',
    status: 'unknown',
    source: 'async-result',
    index: existing?.index,
    description: existing?.description ?? label,
    durationMs: asDuration(raw.durationMs),
    task: existing?.task,
    assignment: existing?.assignment,
    modelRole: existing?.modelRole,
    resolvedModel: existing?.resolvedModel,
    resolvedModelIsFallback: existing?.resolvedModelIsFallback
  }
}

function terminalStatusFromChild(message: JsonRecord | undefined): HistoricalAgentRecord['status'] {
  const stopReason = message?.stopReason
  if (stopReason === 'aborted') return 'aborted'
  if (stopReason === 'error') return 'failed'
  if (stopReason === 'stop' || stopReason === 'length') return 'completed'
  return 'unknown'
}

/** Read one OMP child session artifact (`<parent artifacts>/<agent id>.jsonl`). */
async function recordFromChildSession(
  artifactsDir: string,
  id: string,
  existing: HistoricalAgentRecord
): Promise<HistoricalAgentRecord | null> {
  const childFile = path.join(artifactsDir, `${id}.jsonl`)
  // Agent ids are opaque runtime values; never let a malformed id escape the
  // parent's artifacts directory while resolving a historical sidecar.
  if (path.dirname(childFile) !== artifactsDir) return null

  let text: string
  try {
    text = await readFile(childFile, 'utf8')
  } catch {
    return null
  }

  const activePath = resolveActivePath(parseSessionEntries(text))
  const init = activePath.find((entry) => entry.type === 'session_init')
  const assistantEntries = activePath.filter(
    (entry) => entry.type === 'message' && entry.message?.role === 'assistant'
  )
  const assistantMessages = assistantEntries.map((entry) => entry.message as JsonRecord)
  const finalAssistant = assistantMessages[assistantMessages.length - 1]

  let tokens = 0
  let hasTokens = false
  let cost = 0
  let hasCost = false
  let contextTokens: number | undefined
  for (const message of assistantMessages) {
    const usage = usageRecord(message.usage)
    const messageTokens = usageTokens(usage)
    if (messageTokens !== undefined) {
      tokens += messageTokens
      hasTokens = true
    }
    const messageCost = usageCost(usage)
    if (messageCost !== undefined) {
      cost += messageCost
      hasCost = true
    }
    contextTokens = asFiniteNumber(usage?.contextTokens) ?? asFiniteNumber(usage?.totalTokens) ?? contextTokens
  }

  const record: HistoricalAgentRecord = {
    id,
    agent: typeof init?.agent === 'string' && init.agent ? init.agent : existing.agent,
    agentSource: existing.agentSource,
    status: terminalStatusFromChild(finalAssistant),
    source: 'child-session',
    index: existing.index,
    task: typeof init?.task === 'string' ? init.task : existing.task,
    assignment: existing.assignment,
    description: existing.description,
    lastIntent: existing.lastIntent,
    resolvedModel: typeof init?.resolvedModel === 'string' ? init.resolvedModel : existing.resolvedModel,
    resolvedModelIsFallback: existing.resolvedModelIsFallback,
    modelRole: typeof init?.modelRole === 'string' ? init.modelRole : existing.modelRole,
    // These timestamps are retained only when OMP wrote an explicit timestamp
    // on the corresponding child entry. No Date.now() fallback is allowed.
    startedAt: asTimestamp(init?.timestamp),
    endedAt: asTimestamp(assistantEntries[assistantEntries.length - 1]?.timestamp),
    tokens: hasTokens ? tokens : undefined,
    requests: assistantMessages.length > 0 ? assistantMessages.length : undefined,
    contextTokens,
    cost: hasCost ? cost : undefined,
    resultSummary: finalAssistant ? textFromContent(finalAssistant.content).slice(0, 200) || undefined : undefined
  }
  return record
}

function mergeRecord(existing: HistoricalAgentRecord | undefined, incoming: HistoricalAgentRecord): HistoricalAgentRecord {
  if (!existing) return incoming
  const merged: HistoricalAgentRecord = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) (merged as unknown as JsonRecord)[key] = value
  }
  // An unknown snapshot/result can add telemetry but must never erase a
  // terminal outcome already proven by a SingleResult or child stopReason.
  if (incoming.status === 'unknown' && existing.status !== 'unknown') merged.status = existing.status
  return merged
}

/**
 * Reconstruct durable Agent Hub history from the active parent path:
 *
 * - blocking task calls: upstream `TaskToolDetails.results[]` / `SingleResult`;
 * - background task calls: initial `progress[]` identity, then the durable
 *   `async-result` message and optional child artifact;
 * - child artifacts: structured `session_init`, assistant `stopReason`, and
 *   assistant usage fields.
 *
 * Running is never inferred from a stale progress snapshot, and a missing
 * terminal signal stays `unknown` rather than becoming a fake failure.
 */
export async function reconstructHistoricalAgents(sessionFile: string): Promise<HistoricalAgentRecord[]> {
  let text: string
  try {
    text = await readFile(sessionFile, 'utf8')
  } catch {
    return []
  }

  const activePath = resolveActivePath(parseSessionEntries(text))
  const byId = new Map<string, HistoricalAgentRecord>()

  for (const entry of activePath) {
    if (entry.type === 'message') {
      const msg = entry.message
      if (msg?.role === 'toolResult' && (msg.toolName === 'task' || msg.name === 'task')) {
        const details = isRecord(msg.details) ? msg.details : undefined
        if (details) {
          if (Array.isArray(details.results)) {
            for (const raw of details.results.filter(isRecord)) {
              const record = recordFromResult(raw)
              if (record) byId.set(record.id, mergeRecord(byId.get(record.id), record))
            }
          }
          if (Array.isArray(details.progress)) {
            for (const raw of details.progress.filter(isRecord)) {
              const record = recordFromProgress(raw)
              if (record) byId.set(record.id, mergeRecord(byId.get(record.id), record))
            }
          }
        }
      }
    }

    for (const raw of asyncJobsFromEntry(entry)) {
      const record = recordFromAsyncJob(raw, typeof raw.jobId === 'string' ? byId.get(raw.jobId) : undefined)
      if (record) byId.set(record.id, mergeRecord(byId.get(record.id), record))
    }
  }

  // OMP 17.2.12 writes child sessions to the parent session's artifacts
  // directory, which is the parent JSONL path with its `.jsonl` suffix removed.
  const artifactsDir = sessionFile.endsWith('.jsonl') ? sessionFile.slice(0, -'.jsonl'.length) : undefined
  if (artifactsDir) {
    for (const [id, existing] of byId) {
      const child = await recordFromChildSession(artifactsDir, id, existing)
      if (child) byId.set(id, mergeRecord(existing, child))
    }
  }

  return Array.from(byId.values())
}
