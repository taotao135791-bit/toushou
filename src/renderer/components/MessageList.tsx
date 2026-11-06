import { memo, useEffect, useMemo } from 'react'
import MessageItem from './MessageItem'
import { TurnChangesRow } from './TurnRow'
import { MessageLike, useAppStore } from '../store'
import { turnSummaryFor } from '../lib/execution'
import { projectChatTurns, type ChatTurn } from '../lib/chatFlow'
import { CheckpointInfo } from '@shared/types'
import BoardChatPreview, { boardPreviewReference, groupBoardPreviews } from './BoardChatPreview'
import TurnProcess from './TurnProcess'
import SavedBoardDelivery, { groupSavedBoards, savedBoardReference } from './SavedBoardDelivery'

interface MessageListProps {
  messages: MessageLike[]
  sessionId?: string | null
  onRetry?: (sessionId: string, message: MessageLike) => Promise<boolean>
}

function MessageList({ messages, sessionId = null, onRetry }: MessageListProps) {
  const streaming = useAppStore(state => sessionId ? Boolean(state.busy[sessionId]) : false)
  const projection = useAppStore(state => sessionId ? state.executions[sessionId] : undefined)
  const summary = useMemo(() => projection ? turnSummaryFor(projection) : undefined, [projection])
  const project = useMemo(() => {
    let previous: ChatTurn[] = []
    return (records: MessageLike[]) => {
      previous = projectChatTurns(records, previous)
      return previous
    }
  }, [sessionId])
  const turns = useMemo(() => project(messages), [messages, project])
  const checkpointList = useAppStore(state => sessionId ? state.checkpointsBySession[sessionId] : undefined)
  useEffect(() => {
    if (sessionId) void useAppStore.getState().loadCheckpoints(sessionId)
  }, [sessionId])
  const checkpointByMsgIndex = useMemo(() => {
    const map = new Map<number, CheckpointInfo>()
    for (const checkpoint of checkpointList ?? []) {
      const previous = map.get(checkpoint.msgIndex)
      if (!previous || previous.createdAt > checkpoint.createdAt) map.set(checkpoint.msgIndex, checkpoint)
    }
    return map
  }, [checkpointList])

  return <div className="flex min-w-0 flex-col gap-8 px-5 py-6 sm:px-6">
    {turns.map((turn, index) => <ChatTurnView key={`${sessionId}-${turn.id}`} turn={turn} sessionId={sessionId}
      streaming={streaming && index === turns.length - 1}
      elapsedMs={!streaming && index === turns.length - 1 ? summary?.elapsedMs : undefined}
      checkpoint={turn.ownerIndex === null ? undefined : checkpointByMsgIndex.get(turn.ownerIndex)} onRetry={onRetry} />)}
  </div>
}

interface ChatTurnViewProps {
  turn: ChatTurn
  sessionId: string | null
  streaming: boolean
  elapsedMs?: number
  checkpoint?: CheckpointInfo
  onRetry?: MessageListProps['onRetry']
}

const ChatTurnView = memo(function ChatTurnView({ turn, sessionId, streaming, elapsedMs, checkpoint, onRetry }: ChatTurnViewProps) {
  const references = useMemo(() => groupBoardPreviews(turn.entries.flatMap(({ message }) => {
    const reference = message.toolCall && boardPreviewReference(message.toolCall)
    return reference ? [reference] : []
  })), [turn])
  const savedBoards = useMemo(() => {
    const previews = new Set(references.map(reference => reference.boardId))
    return groupSavedBoards(turn.entries.flatMap(({ message }) => {
      const reference = message.toolCall && savedBoardReference(message.toolCall)
      return reference && !previews.has(reference.boardId) ? [reference] : []
    }))
  }, [turn, references])
  const lastProcess = turn.nodes.findLastIndex(node => node.kind === 'process')
  return <section className="min-w-0 space-y-4" data-chat-turn={turn.id}>
    {turn.nodes.map((node, index) => node.kind === 'message' ?
      <div key={node.entry.message.id} data-message-id={node.entry.message.id} className="msg-row min-w-0">
        <MessageItem message={node.entry.message} index={node.entry.index} sessionId={sessionId} onRetry={onRetry} showBoardAction={node.showBoardAction} />
      </div> :
      <TurnProcess key={node.entries[0].message.id} entries={node.entries} sessionId={sessionId}
        active={streaming && index === turn.nodes.length - 1}
        elapsedMs={!streaming && index === lastProcess ? elapsedMs : undefined} />
    )}
    {sessionId && references.map(group => <BoardChatPreview key={`${sessionId}-${group.boardId}`} sessionId={sessionId} boardId={group.boardId} widgetId={group.widgetIds[0]} widgetIds={group.widgetIds} revision={group.revision} />)}
    {sessionId && savedBoards.map(reference => <SavedBoardDelivery key={`${sessionId}-${reference.boardId}`} sessionId={sessionId} reference={reference} />)}
    {checkpoint && turn.entries.length > 1 && !streaming && <TurnChangesRow sessionId={sessionId} checkpointId={checkpoint.id} />}
  </section>
})

export default memo(MessageList)
