import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { ChatMessage } from '../shared/types'
import { getSession, getSessionMessages } from './omp'
import { mapAgentMessages, type AgentMessage } from './messageMapping'

/** Bounded, control-char-free session id (mirrors the IPC id guard in ipc.ts). */
function isSafeSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

/**
 * Full transcript of a LIVE session for renderer-side backfill (e.g. a
 * Feishu-origin session the GUI attached to mid-conversation). Messages are
 * built by the runtime's own get_messages → mapAgentMessages mapping — the
 * exact parser the resume path uses — never by re-parsing the durable file
 * renderer-style. Null for invalid ids and for sessions that are not live in
 * Main's registry; the caller keeps whatever it already rendered.
 */
export async function readSessionTranscript(sessionId: unknown): Promise<ChatMessage[] | null> {
  if (!isSafeSessionId(sessionId)) return null
  if (!getSession(sessionId)) return null
  return getSessionMessages(sessionId)
}

/** Safety bounds for the file peek: a runaway file must never wedge Main. */
const PEEK_MAX_BYTES = 64 * 1024 * 1024
const PEEK_MAX_MESSAGES = 20_000

/**
 * Instant view of a DURABLE session file, without spawning the runtime
 * (dsh's model: reading a conversation is a data read; attaching the runtime
 * happens when the user actually interacts). Message entries pass through
 * mapAgentMessages — the same mapper the live resume path uses — so a later
 * live swap-in replaces like-for-like. Returns null when the file cannot be
 * read or holds no messages.
 */
export async function readSessionFileTranscript(filePath: string): Promise<ChatMessage[] | null> {
  const agentMessages: AgentMessage[] = []
  try {
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let bytes = 0
    for await (const line of lines) {
      bytes += line.length + 1
      if (bytes > PEEK_MAX_BYTES) break
      if (!line) continue
      try {
        const entry: unknown = JSON.parse(line)
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as { type?: unknown }).type === 'message') {
          const message = (entry as { message?: unknown }).message
          if (message && typeof message === 'object') agentMessages.push(message as AgentMessage)
          if (agentMessages.length >= PEEK_MAX_MESSAGES) break
        }
      } catch {
        // Partial trailing line or a non-JSON record — skip; the runtime's own
        // parser is equally tolerant of its own journal format.
      }
    }
  } catch {
    return null
  }
  if (agentMessages.length === 0) return null
  return mapAgentMessages(agentMessages)
}
