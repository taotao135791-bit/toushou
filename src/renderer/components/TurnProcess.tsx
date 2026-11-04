import { memo, useId, useState } from 'react'
import { ChevronRight, CircleAlert, Loader2 } from 'lucide-react'
import type { IndexedChatMessage } from '../lib/chatFlow'
import { presentToolCall } from '../lib/toolPresentation'
import { formatSeconds } from '../lib/time'
import { useAppStore } from '../store'
import MessageItem from './MessageItem'
import ToolCallCard from './ToolCallCard'

interface Props { entries: IndexedChatMessage[]; sessionId: string | null; active: boolean; elapsedMs?: number }

/** Keep the complete ordered process available without competing with the result. */
function TurnProcess({ entries, sessionId, active, elapsedMs }: Props) {
  const language = useAppStore(state => state.language)
  const zh = language === 'zh'
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const calls = entries.flatMap(entry => entry.message.toolCall ? [entry.message.toolCall] : [])
  const failed = calls.filter(call => presentToolCall(call, language).status === 'failed').length
  const last = calls.at(-1)
  const action = last && active ? presentToolCall(last, language).label : null
  return <section className="min-w-0" aria-label={zh ? '本轮执行过程' : 'Turn activity'}>
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}
      className="focus-ring flex min-h-9 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 text-left text-[12px] text-cream-dim transition-colors hover:bg-overlay">
      {active ? <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" /> : failed ? <CircleAlert size={14} className="shrink-0 text-red-500" aria-hidden="true" /> : <ChevronRight size={14} className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />}
      <span className="min-w-0 flex-1 basis-[100px] truncate font-medium">{action ?? (zh ? '执行过程' : 'Activity')}</span>
      <span className="shrink-0 text-cream-faint">{zh ? `${calls.length} 个步骤` : `${calls.length} steps`}</span>
      {failed > 0 && <span className="shrink-0 text-red-500">{zh ? `${failed} 项失败` : `${failed} failed`}</span>}
      {elapsedMs !== undefined && !active && <span className="ml-auto shrink-0 tabular-nums text-cream-faint">{formatSeconds(elapsedMs)}s</span>}
      <span className="ml-auto shrink-0 text-cream-faint">{expanded ? (zh ? '收起' : 'Hide') : (zh ? '展开' : 'Show')}</span>
    </button>
    <div id={id} hidden={!expanded} className="mt-2 space-y-3 border-l border-line pl-3">
      {expanded && entries.map(({ message, index }) => <div key={message.id} data-message-id={message.id} className="min-w-0">
        {message.toolCall ? <ToolCallCard toolCall={message.toolCall} /> : <MessageItem message={message} index={index} sessionId={sessionId} showBoardAction={false} />}
      </div>)}
    </div>
  </section>
}

export default memo(TurnProcess, (before, after) => before.sessionId === after.sessionId && before.active === after.active && before.elapsedMs === after.elapsedMs &&
  before.entries.length === after.entries.length && before.entries.every((entry, index) => entry.index === after.entries[index].index && entry.message === after.entries[index].message))
