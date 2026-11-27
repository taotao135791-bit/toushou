import type { MessageLike } from '../store'

export interface IndexedChatMessage { message: MessageLike; index: number }
export type ChatFlowNode =
  | { kind: 'message'; entry: IndexedChatMessage; showReplyActions: boolean }
  | { kind: 'process'; entries: IndexedChatMessage[] }
export interface ChatTurn {
  id: string
  ownerIndex: number | null
  entries: IndexedChatMessage[]
  nodes: ChatFlowNode[]
  streaming: boolean
}

function startsTurn(message: MessageLike): boolean {
  return message.role === 'user' && message.kind !== 'steer'
}

const hasNarrative = (content: string): boolean => /[^\p{P}\s]/u.test(content)

/** A presentation only projection: no transcript records or indices are changed. */
export function projectChatTurns(messages: MessageLike[], previousTurns: ChatTurn[] = [], streaming = false): ChatTurn[] {
  const turns: ChatTurn[] = []
  let start = 0
  while (start < messages.length) {
    const previous = previousTurns[turns.length]
    if (previous && previous.entries[0].message === messages[start]) {
      const end = start + previous.entries.length
      if (end <= messages.length &&
        (end === messages.length || startsTurn(messages[end])) &&
        previous.streaming === (streaming && end === messages.length) &&
        previous.entries.every((entry, offset) => entry.index === start + offset && entry.message === messages[start + offset])) {
        turns.push(previous)
        start = end
        continue
      }
    }
    const first = messages[start]
    const entries: IndexedChatMessage[] = [{ message: first, index: start }]
    let end = start + 1
    while (end < messages.length && !startsTurn(messages[end])) {
      entries.push({ message: messages[end], index: end })
      end++
    }
    const turn: ChatTurn = {
      id: first.id,
      ownerIndex: startsTurn(first) ? start : null,
      entries,
      nodes: [],
      streaming: streaming && end === messages.length
    }
    turns.push(turn)
    start = end

    let lastTool = -1
    for (let i = 0; i < turn.entries.length; i++) if (turn.entries[i].message.toolCall) lastTool = i
    // Punctuation-only text between tools stays in the process while the
    // turn is live. A completed turn can still use it as its only answer.
    let answer = -1
    let punctuationOnlyAnswer = -1
    for (let i = lastTool + 1; i < turn.entries.length; i++) {
      const message = turn.entries[i].message
      if (message.role !== 'assistant' || message.toolCall || !message.content.trim()) continue
      if (hasNarrative(message.content)) answer = i
      else if (!turn.streaming) punctuationOnlyAnswer = i
    }
    if (answer === -1) answer = punctuationOnlyAnswer
    let process: IndexedChatMessage[] = []
    const flush = () => {
      if (process.length) turn.nodes.push({ kind: 'process', entries: process })
      process = []
    }
    turn.entries.forEach((entry, i) => {
      const { message } = entry
      if (lastTool >= 0 && message.role === 'assistant' && !message.replyKey && i !== answer &&
          (message.toolCall || !hasNarrative(message.content))) {
        process.push(entry)
      } else {
        // Narration, errors and steering break adjacent tool runs and stay in transcript order.
        flush()
        turn.nodes.push({ kind: 'message', entry, showReplyActions: Boolean(message.replyKey) || lastTool < 0 || i === answer })
      }
    })
    flush()
  }
  return turns
}
