import { memo, useEffect, useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import MessageItem from './MessageItem'
import { TurnChangesRow } from './TurnRow'
import { MessageLike, useAppStore } from '../store'
import { useT } from '../i18n'
import { lastTurn, turnElapsedMs } from '../lib/execution'
import { projectChatTurns, type ChatTurn } from '../lib/chatFlow'
import { CheckpointInfo } from '@shared/types'
import BoardChatPreview, { boardPreviewReference, groupBoardPreviews } from './BoardChatPreview'
import TurnProcess from './TurnProcess'
import SavedBoardDelivery, { groupSavedBoards, savedBoardReferences } from './SavedBoardDelivery'

interface MessageListProps {
  messages: MessageLike[]
  sessionId?: string | null
  onRetry?: (sessionId: string, message: MessageLike) => Promise<boolean>
  /** 开分支: fork the conversation up to the chosen turn into a new session. */
  onBranch?: (sessionId: string, keepUserTurns: number) => void
}

function MessageList({ messages, sessionId = null, onRetry, onBranch }: MessageListProps) {
  const streaming = useAppStore(state => sessionId ? Boolean(state.busy[sessionId]) : false)
  const canEditSavedBoards = useAppStore(state => !!sessionId && state.currentSessionId === sessionId &&
    !state.sessions.some(session => session.id === sessionId && session.readonly))
  const lastElapsedMs = useAppStore(state => {
    if (!sessionId || state.busy[sessionId]) return undefined
    const projection = state.executions[sessionId]
    const turn = projection && lastTurn(projection)
    return turn ? turnElapsedMs(turn) : undefined
  })
  const project = useMemo(() => {
    let previous: ChatTurn[] = []
    return (records: MessageLike[], active: boolean) => {
      previous = projectChatTurns(records, previous, active)
      return previous
    }
  }, [sessionId])
  const turns = useMemo(() => project(messages, streaming), [messages, project, streaming])
  // Once per render (not per item): the thinking-disclosure policy needs the
  // index of the last user message.
  const lastUserIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i
    return -1
  }, [messages])
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
      elapsedMs={index === turns.length - 1 ? lastElapsedMs : undefined}
      canEditSavedBoards={canEditSavedBoards}
      checkpoint={turn.ownerIndex === null ? undefined : checkpointByMsgIndex.get(turn.ownerIndex)} onRetry={onRetry}
      branchOrdinal={sessionId && !sessionId.startsWith('preview:') && onBranch && !streaming ? index + 1 : undefined}
      lastUserIndex={Math.min(lastUserIndex, (turn.entries.at(-1)?.index ?? -1) + 1)} onBranch={onBranch} />)}
  </div>
}

interface ChatTurnViewProps {
  turn: ChatTurn
  sessionId: string | null
  streaming: boolean
  canEditSavedBoards: boolean
  elapsedMs?: number
  checkpoint?: CheckpointInfo
  onRetry?: MessageListProps['onRetry']
  /** 1-based user-turn ordinal when branching from this turn is offered. */
  branchOrdinal?: number
  /** Index of the last user message (thinking-disclosure policy input). */
  lastUserIndex?: number
  onBranch?: MessageListProps['onBranch']
}

const ChatTurnView = memo(function ChatTurnView({ turn, sessionId, streaming, canEditSavedBoards, elapsedMs, checkpoint, onRetry, branchOrdinal, lastUserIndex, onBranch }: ChatTurnViewProps) {
  const references = useMemo(() => groupBoardPreviews(turn.entries.flatMap(({ message }) => {
    const reference = message.toolCall && boardPreviewReference(message.toolCall)
    return reference ? [reference] : []
  })), [turn])
  const savedBoards = useMemo(() => {
    const previews = new Set(references.map(reference => reference.boardId))
    return groupSavedBoards(turn.entries.flatMap(({ message }) => {
      return message.toolCall
        ? savedBoardReferences(message.toolCall).filter(reference => !previews.has(reference.boardId))
        : []
    }))
  }, [turn, references])
  const lastProcess = turn.nodes.findLastIndex(node => node.kind === 'process')
  const streamingMessageIndex = streaming ? turn.entries.at(-1)?.index : undefined
  const t = useT()
  return <section className="group/turn min-w-0 space-y-4" data-chat-turn={turn.id}>
    {branchOrdinal !== undefined && sessionId && onBranch && (
      <div className="flex justify-end opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
        <button
          type="button"
          onClick={() => onBranch(sessionId, branchOrdinal)}
          title={t('history.branchFromHere')}
          className="focus-ring flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-cream-faint hover:border-accent/40 hover:text-cream-dim"
        >
          <GitBranch size={10} />
          {t('history.branchFromHere')}
        </button>
      </div>
    )}
    {turn.nodes.map((node, index) => node.kind === 'message' ?
      <div key={node.entry.message.id} data-message-id={node.entry.message.id} className="msg-row min-w-0">
        <MessageItem message={node.entry.message} index={node.entry.index} lastUserIndex={lastUserIndex} sessionId={sessionId} onRetry={onRetry}
          streaming={node.entry.index === streamingMessageIndex} turnActive={streaming} showBoardAction={node.showBoardAction} />
      </div> :
      <TurnProcess key={node.entries[0].message.id} entries={node.entries} sessionId={sessionId} lastUserIndex={lastUserIndex}
        active={streaming && index === turn.nodes.length - 1}
        elapsedMs={!streaming && index === lastProcess ? elapsedMs : undefined} />
    )}
    {sessionId && references.map(group => <BoardChatPreview key={`${sessionId}-${group.boardId}`} sessionId={sessionId} boardId={group.boardId} widgetId={group.widgetIds[0]} widgetIds={group.widgetIds} revision={group.revision} />)}
    {sessionId && savedBoards.map(reference => <SavedBoardDelivery key={`${sessionId}-${reference.boardId}`} sessionId={sessionId} reference={reference} canEdit={canEditSavedBoards} />)}
    {checkpoint && turn.entries.length > 1 && !streaming && <TurnChangesRow sessionId={sessionId} checkpointId={checkpoint.id} />}
  </section>
})

export default memo(MessageList)
