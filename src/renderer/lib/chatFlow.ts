import type { MessageLike } from '../store'

export interface IndexedChatMessage { message: MessageLike; index: number }
export type ChatFlowNode =
  | { kind: 'message'; entry: IndexedChatMessage; showBoardAction: boolean }
  | { kind: 'process'; entries: IndexedChatMessage[] }
export interface ChatTurn {
  id: string
  ownerIndex: number | null
  entries: IndexedChatMessage[]
  nodes: ChatFlowNode[]
  streaming: boolean
}

/** A presentation only projection: no transcript records or indices are changed. */
export function projectChatTurns(messages: MessageLike[], previousTurns: ChatTurn[] = [], streaming = false): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const startsTurn = message.role === 'user' && message.kind !== 'steer'
    if (!turns.length || startsTurn) {
      turns.push({ id: message.id, ownerIndex: startsTurn ? index : null, entries: [], nodes: [], streaming: false })
    }
    turns[turns.length - 1].entries.push({ message, index })
  }
  const previousById = new Map(previousTurns.map(turn => [turn.id, turn]))
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]
    turn.streaming = streaming && turnIndex === turns.length - 1
    const previous = previousById.get(turn.id)
    if (previous && previous.ownerIndex === turn.ownerIndex && previous.streaming === turn.streaming && previous.entries.length === turn.entries.length &&
      previous.entries.every((entry, index) => entry.index === turn.entries[index].index && entry.message === turn.entries[index].message)) {
      turns[turnIndex] = previous
      continue
    }
    let lastTool = -1
    for (let i = 0; i < turn.entries.length; i++) if (turn.entries[i].message.toolCall) lastTool = i
    // Punctuation-only text between tools stays in the process while the
    // turn is live. A completed turn can still use it as its only answer.
    let answer = -1
    let punctuationOnlyAnswer = -1
    for (let i = lastTool + 1; i < turn.entries.length; i++) {
      const message = turn.entries[i].message
      if (message.role !== 'assistant' || message.toolCall || !message.content.trim()) continue
      if (/[^\p{P}\s]/u.test(message.content)) answer = i
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
      if (lastTool >= 0 && message.role === 'assistant' && i !== answer) {
        process.push(entry)
      } else {
        // System errors and user steering stay visible in their original
        // position, never inside a collapsed activity section.
        flush()
        turn.nodes.push({ kind: 'message', entry, showBoardAction: lastTool < 0 || i === answer })
      }
    })
    flush()
  }
  return turns
}
