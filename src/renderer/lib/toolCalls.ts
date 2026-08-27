import type { SessionEvent } from '../../shared/types'

/** Tool-call card payload carried by assistant messages (MessageLike.toolCall). */
export interface ToolCallRecord {
  /** pi's stable toolCallId — present when the main process supplied one. */
  id?: string
  tool: string
  input: unknown
  output?: unknown
  isError?: boolean
}

export type ToolResultEvent = Extract<SessionEvent, { type: 'tool_result' }>

/** Minimal message shape applyToolResult needs; the store's MessageLike satisfies it. */
export interface ToolCallMessage {
  id: string
  role: string
  content: string
  toolCall?: ToolCallRecord
}

/**
 * Merge a tool_result event into the message list (returns a new array):
 *
 * - event.id present (pi's toolCallId): exact match on the card carrying that
 *   id. Parallel tool runs pair by id, never by name+recency, so out-of-order
 *   results (bash B finishing before bash A) still land on their own card.
 *   An id that matches nothing becomes an orphan card — never a name match,
 *   which could steal the result of a different parallel call.
 * - event.id absent: legacy fallback — the most recent still-pending card of
 *   the same tool, the pre-toolCallId behavior kept for old upstreams.
 * - no match at all: an orphan card without input (result arrived without
 *   its call), same as the store always did.
 */
export function applyToolResult<T extends ToolCallMessage>(
  messages: T[],
  event: ToolResultEvent
): T[] {
  const mergeAt = (idx: number): T[] => {
    const target = messages[idx]
    const merged = {
      ...target,
      toolCall: { ...target.toolCall!, output: event.output, isError: event.isError }
    }
    const updated = [...messages]
    updated[idx] = merged
    return updated
  }

  if (event.id) {
    // Exact match by toolCallId — prefer the still-pending card; a duplicate
    // result re-merges onto its (already resolved) card.
    for (let i = messages.length - 1; i >= 0; i--) {
      const tc = messages[i].toolCall
      if (tc && tc.id === event.id && tc.output === undefined) return mergeAt(i)
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].toolCall?.id === event.id) return mergeAt(i)
    }
  } else {
    // Legacy fallback (no toolCallId on the event): most recent pending card
    // of the same tool.
    for (let i = messages.length - 1; i >= 0; i--) {
      const tc = messages[i].toolCall
      if (tc && tc.output === undefined && tc.tool === event.tool) return mergeAt(i)
    }
  }

  // Orphan result: no matching call card — render it on a card of its own.
  const orphan = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    toolCall: {
      id: event.id,
      tool: event.tool,
      input: undefined,
      output: event.output,
      isError: event.isError
    }
  }
  return [...messages, orphan as T]
}
