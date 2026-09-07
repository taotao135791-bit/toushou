import { ChatMessage } from '../shared/types'
import { getSession, getSessionMessages } from './omp'

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
