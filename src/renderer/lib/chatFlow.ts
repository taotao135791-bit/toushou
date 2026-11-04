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
}

/** A presentation only projection: no transcript records or indices are changed. */
export function projectChatTurns(messages: MessageLike[], previousTurns: ChatTurn[] = []): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const startsTurn = message.role === 'user' && message.kind !== 'steer'
    if (!turns.length || startsTurn) {
      turns.push({ id: message.id, ownerIndex: startsTurn ? index : null, entries: [], nodes: [] })
    }
    turns[turns.length - 1].entries.push({ message, index })
  }
  const previousById = new Map(previousTurns.map(turn => [turn.id, turn]))
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]
    const previous = previousById.get(turn.id)
    if (previous && previous.ownerIndex === turn.ownerIndex && previous.entries.length === turn.entries.length &&
      previous.entries.every((entry, index) => entry.index === turn.entries[index].index && entry.message === turn.entries[index].message)) {
      turns[turnIndex] = previous
      continue
    }
    let lastTool = -1
    for (let i = 0; i < turn.entries.length; i++) if (turn.entries[i].message.toolCall) lastTool = i
    // Text after the last tool is the visible answer. Earlier commentary is
    // retained in the expandable process, even if it is just punctuation.
    let answer = -1
    for (let i = lastTool + 1; i < turn.entries.length; i++) {
      const message = turn.entries[i].message
      if (message.role === 'assistant' && !message.toolCall && message.content.trim()) answer = i
    }
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
