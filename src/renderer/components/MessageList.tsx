import { ReactNode, useMemo } from 'react'
import MessageItem from './MessageItem'
import { ToolGroup } from './TurnRow'
import { MessageLike, useAppStore } from '../store'
import { turnActivityFor, turnSummaryFor } from '../lib/execution'

interface MessageListProps {
  messages: MessageLike[]
  sessionId?: string | null
}

/**
 * Vertical rhythm: a loose 28px gap between turns, tightened inside a
 * question→answer pair (user bubble → reply hugs at 12px, consecutive user
 * bubbles stack compactly).
 */
function gapBefore(prev: MessageLike | undefined, nextIsUser: boolean): string {
  if (!prev) return ''
  if (prev.role === 'user') return nextIsUser ? 'mt-2' : 'mt-3'
  return 'mt-7'
}

export default function MessageList({ messages, sessionId = null }: MessageListProps) {
  const streaming = useAppStore((s) => (sessionId ? Boolean(s.busy[sessionId]) : false))
  // Live progress / frozen summary derive from the single execution projection
  // — never from a second per-turn counter store.
  // Select the stable projection reference first. Calling the projection
  // helpers inside a Zustand selector creates a fresh object on every store
  // read; React 18 treats that as an unstable external-store snapshot and can
  // enter update-depth #185 once a live response starts rendering.
  const projection = useAppStore((s) => (sessionId ? s.executions[sessionId] : undefined))
  const activity = useMemo(() => (projection ? turnActivityFor(projection) : undefined), [projection])
  const summary = useMemo(() => (projection ? turnSummaryFor(projection) : undefined), [projection])

  // Turn boundary marker: groups after the last user message belong to the
  // current (or just-finished) turn and get the live row / frozen summary.
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)
  // The frozen summary (with elapsed time) pins to the LAST tool group of the
  // turn — earlier groups in the same turn show derived counts only.
  const lastToolIdx = messages.reduce(
    (acc, m, i) => (m.toolCall && i > lastUserIdx ? i : acc),
    -1
  )

  const nodes: ReactNode[] = []
  let prev: MessageLike | undefined
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    // Consecutive tool calls collapse into one bordered group with hairline
    // separators — a list, not a stack of boxes (Claude Code style).
    if (message.toolCall) {
      const run: MessageLike[] = []
      const runStart = i
      let j = i
      while (j < messages.length && messages[j].toolCall) {
        run.push(messages[j])
        j++
      }
      const isLastRun = j === messages.length
      const inCurrentTurn = runStart > lastUserIdx
      const isTurnsLastGroup = lastToolIdx >= runStart && lastToolIdx < j
      nodes.push(
        <div key={message.id} className={gapBefore(prev, false)}>
          <ToolGroup
            run={run}
            // Only the live turn's groups follow the stream; historical
            // groups keep the user's manual expand/collapse.
            streaming={streaming && inCurrentTurn}
            activity={streaming && isLastRun && inCurrentTurn ? activity : undefined}
            summary={!streaming && isTurnsLastGroup ? summary : undefined}
          />
        </div>
      )
      prev = messages[j - 1]
      i = j
      continue
    }
    nodes.push(
      <div key={message.id} className={gapBefore(prev, message.role === 'user')}>
        <MessageItem message={message} index={i} sessionId={sessionId} />
      </div>
    )
    prev = message
    i++
  }
  return <div className="flex flex-col px-6 py-8">{nodes}</div>
}
