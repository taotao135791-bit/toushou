import { memo, ReactNode, useEffect, useMemo } from 'react'
import MessageItem from './MessageItem'
import { ToolGroup, TurnChangesRow } from './TurnRow'
import { MessageLike, useAppStore } from '../store'
import { turnActivityFor, turnSummaryFor } from '../lib/execution'
import { CheckpointInfo } from '@shared/types'

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

/** A new turn starts at a real user prompt; steers continue the active turn. */
function isTurnStart(message: MessageLike): boolean {
  return message.role === 'user' && message.kind !== 'steer'
}

function MessageList({ messages, sessionId = null }: MessageListProps) {
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

  // Per-turn change chips: load the session's checkpoints once per selection;
  // newly dispatched turns append theirs via createCheckpointForMessage.
  const checkpointList = useAppStore((s) =>
    sessionId ? s.checkpointsBySession[sessionId] : undefined
  )
  useEffect(() => {
    if (sessionId) void useAppStore.getState().loadCheckpoints(sessionId)
  }, [sessionId])
  const checkpointByMsgIndex = useMemo(() => {
    const map = new Map<number, CheckpointInfo>()
    for (const c of checkpointList ?? []) {
      const prev = map.get(c.msgIndex)
      if (!prev || prev.createdAt >= c.createdAt) map.set(c.msgIndex, c)
    }
    return map
  }, [checkpointList])

  // Turn boundary marker: groups after the last user message belong to the
  // current (or just-finished) turn and get the live row / frozen summary.
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)
  // The frozen summary (with elapsed time) pins to the LAST tool group of the
  // turn — earlier groups in the same turn show derived counts only.
  const lastToolIdx = messages.reduce(
    (acc, m, i) => (m.toolCall && i > lastUserIdx ? i : acc),
    -1
  )

  // Map "last node index of a turn" -> the user message that owns it, so the
  // change chip renders after the turn's final node. Turns with no content
  // after the prompt (back-to-back user bubbles) never own a chip.
  const turnOwnerByEnd = useMemo(() => {
    const map = new Map<number, number>()
    for (let u = 0; u < messages.length; u += 1) {
      if (!isTurnStart(messages[u])) continue
      let end = u
      while (end + 1 < messages.length && !isTurnStart(messages[end + 1])) end += 1
      if (end > u) map.set(end, u)
    }
    return map
  }, [messages])

  const nodes: ReactNode[] = []
  let prev: MessageLike | undefined
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    let turnEndIdx: number
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
      turnEndIdx = j - 1
      const isLastRun = j === messages.length
      const inCurrentTurn = runStart > lastUserIdx
      const isTurnsLastGroup = lastToolIdx >= runStart && lastToolIdx < j
      nodes.push(
        <div key={message.id} className={`msg-row ${gapBefore(prev, false)}`}>
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
    } else {
      turnEndIdx = i
      nodes.push(
        <div key={message.id} className={`msg-row ${gapBefore(prev, message.role === 'user')}`}>
          <MessageItem message={message} index={i} sessionId={sessionId} />
        </div>
      )
      prev = message
      i++
    }
    // The per-turn change chip closes a completed turn. The turn still being
    // streamed (last node, session busy) waits: when the run finishes, the
    // row mounts and fetches its diff exactly once.
    const chipOwner = turnOwnerByEnd.get(turnEndIdx)
    if (chipOwner !== undefined && !(streaming && turnEndIdx === messages.length - 1)) {
      const checkpoint = checkpointByMsgIndex.get(chipOwner)
      if (checkpoint) {
        nodes.push(
          <div key={`turn-changes-${checkpoint.id}`} className="msg-row -mt-4">
            <TurnChangesRow sessionId={sessionId} checkpointId={checkpoint.id} />
          </div>
        )
      }
    }
  }
  return <div className="flex flex-col px-6 py-8">{nodes}</div>
}

export default memo(MessageList)
