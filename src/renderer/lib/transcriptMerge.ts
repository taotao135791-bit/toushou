/**
 * Alignment merge for transcript backfill. When the GUI opens an externally
 * created session (Feishu), the store may already hold messages folded from
 * live events, while the Main-fetched durable transcript is authoritative but
 * was snapshotted slightly earlier. Streaming events can land mid-fetch, so a
 * blind replace would drop the freshest tail.
 *
 * Invariants (both lists describe the same conversation):
 * - the streamed store rows are always live-fresh — deltas keep appending to
 *   the in-flight message, so the streamed copy self-heals;
 * - the durable copy may additionally contain OLDER history the store never
 *   saw (the renderer only folds events since it started listening).
 *
 * A greedy backward walk therefore matches streamed rows to durable rows
 * (role + content, tool cards by tool name; the single in-flight tail row may
 * be a strict prefix of its durable copy). Whatever durable rows remain
 * UNMATCHED above the walk are the missing history and get prepended; every
 * streamed row is kept. Nothing is ever lost — worst case (no alignment) the
 * result is durable prefix + streamed rows, i.e. possible visual duplicates.
 *
 * Structural on purpose (no import from the store): any message-like row with
 * id/role/content qualifies, so ChatMessage[] and MessageLike[] both fit.
 */
interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCall?: { tool: string }
}

/**
 * True when `a` (durable) and `b` (streamed) can describe the same underlying
 * message. `isTail` loosens the assistant comparison: the streamed copy of
 * the in-flight message may be a strict prefix (or — after a reload raced a
 * turn — a fresher continuation) of the durable snapshot.
 */
function sameRow(a: TranscriptMessage, b: TranscriptMessage, isTail: boolean): boolean {
  if (a.role !== b.role) return false
  if (a.toolCall || b.toolCall) {
    return Boolean(a.toolCall && b.toolCall && a.toolCall.tool === b.toolCall.tool)
  }
  if (a.role !== 'assistant') return a.content === b.content
  if (a.content === b.content) return true
  return (
    isTail &&
    (a.content.length > b.content.length
      ? a.content.startsWith(b.content)
      : b.content.startsWith(a.content))
  )
}

/**
 * Durable transcript merged with the streamed store rows: unmatched durable
 * history is prepended, all streamed rows (including rows that landed while
 * the fetch was in flight) are kept.
 */
export function mergeTranscriptBackfill<T extends TranscriptMessage>(fetched: T[], current: T[]): T[] {
  if (current.length === 0) return fetched
  if (fetched.length === 0) return current
  let f = fetched.length - 1
  let c = current.length - 1
  while (f >= 0 && c >= 0) {
    if (sameRow(fetched[f], current[c], c === current.length - 1)) {
      f -= 1
      c -= 1
    } else {
      // A streamed row with no durable counterpart: newer than the snapshot
      // (it is kept via `current` below), so skip it and keep looking for the
      // alignment point further back.
      c -= 1
    }
  }
  // fetched[0..f] never matched a streamed row — that is the history the
  // store is missing.
  return [...fetched.slice(0, f + 1), ...current]
}
