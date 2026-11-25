import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReplyForkTarget } from '../shared/types'
import { assistantReplyKey, isFinalAssistantMessage } from './assistantReplyKey'
import { isSessionFilePath, listAllSessions, readSessionHistoryMetadata } from './sessionHistory'
import { normalizeSessionTitleFile } from './sessionNaming'

/**
 * Session forking: duplicate a durable session file, optionally truncated to
 * its first `keepUserTurns` COMPLETE user turns, as the starting point of a
 * new live conversation (开分支 / 复制会话).
 *
 * The fork is a NEW file with a NEW session uuid written next to the source
 * (same cwd-encoded directory, so the runtime's scanner and the history list
 * pick it up naturally). The original is never touched: resuming the fork
 * creates yet another live file, exactly like a normal resume.
 *
 * Turn semantics: "turn k" = user message k plus every record after it up to
 * (excluding) user message k+1. Truncating before user message k+1 keeps
 * turn k's assistant reply intact, so a branch always starts from a clean,
 * complete exchange — never a dangling user message the runtime might answer
 * again on its own.
 */

const MAX_SESSION_FORK_BYTES = 64 * 1024 * 1024

interface ForkedLine {
  line: string
}

/**
 * True when the record STARTS a user turn. Steering messages are role "user"
 * with `steering: true` (see messageMapping) but belong to the CURRENT turn —
 * counting them as turn boundaries truncated the fork mid-turn (the UI's turn
 * ordinals exclude them too, so keep the same definition here).
 */
function isUserTurnStart(record: Record<string, unknown>): boolean {
  if (record.type !== 'message') return false
  const message = record.message
  if (!message || typeof message !== 'object') return false
  const entry = message as { role?: unknown; steering?: unknown }
  return entry.role === 'user' && entry.steering !== true
}

export interface SessionForkResult {
  /** Absolute path of the new forked session file. */
  filePath: string
  /** Fresh session uuid written into the fork's header. */
  uuid: string
  /** User turns retained (equals the source's total for a full copy). */
  keptUserTurns: number
}

interface ForkOptions {
  reply?: ReplyForkTarget
  keepUserTurns?: number
  titleSuffix?: string
  agentDir?: string
  completeTurnsOnly?: boolean
}

interface BranchTitleContext {
  liveTitle?: string
  resumeFrom?: string
  titles?: () => { overlays: ReadonlyMap<string, { title?: string }>; live: readonly string[] }
}

const TITLE_SLOT_BYTES = 256 // OMP's physical first line, including the newline.
function branchTitleSlot(title: string, updatedAt: string) {
  return { type: 'title', v: 1, title, source: 'user', updatedAt, pad: '' }
}

function numberedTitle(base: string, number: number, updatedAt: string): string {
  const suffix = `（${number}）`
  const points = Array.from(base.slice(0, 80).replace(/[\uD800-\uDBFF]$/, ''))
  // Reserve the ordinal before shortening a long Unicode title for OMP.
  while (points.length) {
    const candidate = points.join('') + suffix
    if (candidate.length <= 80 && Buffer.byteLength(JSON.stringify(branchTitleSlot(candidate, updatedAt))) + 1 <= TITLE_SLOT_BYTES) return candidate
    points.pop()
  }
  return suffix
}

// Electron Main owns all fork IPCs. Release the queue when the new file is
// durable, before the slower native process handshake.
let pendingBranch = Promise.resolve()
export function forkNumberedSessionFile(file: string, options: ForkOptions, context: BranchTitleContext = {}) {
  const write = pendingBranch.then(async () => {
    if (!isSessionFilePath(file, options.agentDir)) throw new Error('not-a-session-file')
    const history = await listAllSessions(options.agentDir, Infinity)
    const names = context.titles?.()
    const overlay = (path: string) => names?.overlays.size ? names.overlays.get(normalizeSessionTitleFile(path))?.title : undefined
    const source = await readSessionHistoryMetadata(file)
    const restored = context.resumeFrom && context.resumeFrom !== file ? await readSessionHistoryMetadata(context.resumeFrom) : null
    const display = overlay(file) || (context.resumeFrom && overlay(context.resumeFrom)) || context.liveTitle ||
      restored?.title || source?.title || 'Untitled'
    const lineage = source?.branchName ?? restored?.branchName
    const base = lineage?.title === display ? lineage.base : display
    const taken = new Set(history.map(row => overlay(row.filePath) || row.title))
    for (const title of names?.live ?? []) taken.add(title)
    const updatedAt = new Date().toISOString()
    let ordinal = 1
    let title = numberedTitle(base, ordinal, updatedAt)
    while (taken.has(title)) title = numberedTitle(base, ++ordinal, updatedAt)
    const fork = await forkSessionFile(file, { ...options, branchName: { base, title, updatedAt } })
    return { ...fork, title }
  })
  pendingBranch = write.then(() => undefined, () => undefined)
  return write
}

/**
 * Write the forked copy. `keepUserTurns` undefined/Infinity = duplicate the
 * whole conversation. `completeTurnsOnly` (with keepUserTurns omitted) keeps
 * every COMPLETE turn and drops a trailing turn that never got an assistant
 * reply — branching a mid-stream session lands on the last finished exchange
 * instead of a half-written tail. Throws for oversized or malformed sources —
 * the caller reports honestly instead of resuming a half-written file.
 */
export async function forkSessionFile(
  sourceFilePath: string,
  options: ForkOptions & { branchName?: { base: string; title: string; updatedAt: string } } = {}
): Promise<SessionForkResult> {
  if (!isSessionFilePath(sourceFilePath, options.agentDir)) throw new Error('not-a-session-file')
  const keep = options.keepUserTurns === undefined || !Number.isFinite(options.keepUserTurns)
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(options.keepUserTurns))
  const raw = await readFile(sourceFilePath, 'utf8')
  if (raw.length > MAX_SESSION_FORK_BYTES) throw new Error('session-file-too-large')
  const lines = raw.split('\n')
  // A trailing newline produces one empty last element — keep alignment by
  // filtering only fully empty tails, preserving interior blank lines verbatim.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const kept: ForkedLine[] = []
  let matchingReplies = 0
  let replyEnd: { lines: number; turns: number } | undefined
  let userTurns = 0
  let truncated = false
  // Trailing-turn completeness tracking for completeTurnsOnly: where the last
  // user turn started, and whether its assistant reply has finished.
  let lastUserTurnStart = -1
  let lastTurnHasAssistant = false
  for (const line of lines) {
    let record: Record<string, unknown> | null = null
    if (line) {
      try {
        const parsed: unknown = JSON.parse(line)
        record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch {
        record = null
      }
    }
    if (record && isUserTurnStart(record)) {
      if (userTurns >= keep) { truncated = true; break }
      lastUserTurnStart = kept.length
      lastTurnHasAssistant = false
      userTurns++
    }
    if (
      record &&
      record.type === 'message' &&
      (record.message as { role?: unknown } | undefined)?.role === 'assistant'
    ) {
      const assistant = record.message as { role: string; stopReason?: unknown; content?: unknown }
      lastTurnHasAssistant = isFinalAssistantMessage(assistant)
      if (options.reply && assistantReplyKey(assistant) === options.reply.key) {
        matchingReplies++
        if (matchingReplies === options.reply.occurrence) replyEnd = { lines: kept.length + 1, turns: userTurns }
      }
    }
    kept.push({ line })
  }
  if (options.reply) {
    if (!replyEnd || matchingReplies !== options.reply.total) throw new Error('reply-not-found')
    kept.length = replyEnd.lines
    userTurns = replyEnd.turns
  } else if (!truncated && options.completeTurnsOnly && userTurns > 0 && !lastTurnHasAssistant) {
    // The final turn is still unanswered (mid-stream source): drop it so the
    // branch starts from a complete exchange. Reuses the truncated-tail
    // cleanup below to strip that turn's dangling non-message records.
    kept.length = lastUserTurnStart
    truncated = true
    userTurns--
  } else if (Number.isFinite(keep) && userTurns > 0 && !lastTurnHasAssistant) {
    throw new Error('incomplete-turn')
  }
  if (truncated) {
    // Drop a dangling tail of non-message records that belonged to the NEXT
    // (dropped) turn — progress/tool records after the cut mean nothing
    // without their user message.
    while (kept.length > 0) {
      const last = kept[kept.length - 1].line
      if (!last) { kept.pop(); continue }
      let lastRecord: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(last)
        lastRecord = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
      } catch { lastRecord = null }
      if (!lastRecord) break
      // Everything except the session/title header lines and messages is a
      // turn-scoped record; only message/session/title survive the cut.
      if (lastRecord.type === 'message' || lastRecord.type === 'session' || lastRecord.type === 'title') break
      kept.pop()
    }
  }
  if (userTurns === 0 && !replyEnd) throw new Error('no-user-turns')

  const uuid = randomUUID()
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
  const outLines: string[] = []
  const branch = options.branchName
  if (branch) {
    const slot = branchTitleSlot(branch.title, branch.updatedAt)
    slot.pad = ' '.repeat(TITLE_SLOT_BYTES - Buffer.byteLength(JSON.stringify(slot)) - 1)
    outLines.push(JSON.stringify(slot))
  }
  for (const entry of kept) {
    if (!entry.line) { outLines.push(entry.line); continue }
    try {
      const parsed: unknown = JSON.parse(entry.line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (record.type === 'session') {
          const header = { ...record, id: uuid, timestamp: new Date().toISOString() } as Record<string, unknown>
          if (branch) {
            header.title = branch.title
            header.titleSource = 'user'
            header.toushouBranch = { base: branch.base, title: branch.title }
          } else {
            delete header.toushouBranch
          }
          outLines.push(JSON.stringify(header))
          continue
        }
        if (record.type === 'title' && branch) continue
        if (record.type === 'title' && options.titleSuffix && typeof record.title === 'string') {
          const merged = `${record.title}${options.titleSuffix}`.slice(0, 120)
          outLines.push(JSON.stringify({ ...record, title: merged, source: 'user' }))
          continue
        }
      }
    } catch { /* unparseable lines ride along verbatim */ }
    outLines.push(entry.line)
  }
  const dir = path.dirname(path.resolve(sourceFilePath))
  const filePath = path.join(dir, `${timestamp}_${uuid}.jsonl`)
  await writeFile(filePath, `${outLines.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
  return { filePath, uuid, keptUserTurns: userTurns }
}
