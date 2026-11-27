import { memo, useId, useMemo, useState } from 'react'
import { Brain, ChevronDown, CircleAlert, ListChecks, Loader2, Search, SquareTerminal } from 'lucide-react'
import type { IndexedChatMessage } from '../lib/chatFlow'
import { presentToolCall } from '../lib/toolPresentation'
import { toolBrandForCall } from '../lib/toolBrand'
import { formatSeconds } from '../lib/time'
import { useAppStore } from '../store'
import MessageItem from './MessageItem'
import ToolCallCard from './ToolCallCard'
import BrandIcon from './BrandIcon'

interface Props {
  entries: IndexedChatMessage[]
  sessionId: string | null
  active: boolean
  elapsedMs?: number
  lastUserIndex?: number
  streamingMessageIndex?: number
}

function summarizeActivity(entries: IndexedChatMessage[], language: 'zh' | 'en', active: boolean) {
  const steps = entries.flatMap(({ message }) => {
    const call = message.toolCall
    if (!call || call.tool === 'toushou_session_topic') return []
    const presentation = presentToolCall(call, language)
    return [{ call, ...presentation, name: [presentation.label, presentation.summary].filter(Boolean).join(' · ') }]
  })
  const count = steps.length
  const failed = steps.filter(step => step.status === 'failed').length
  const running = active && steps.findLast(step => step.status === 'running')
  const primary = running || steps.findLast(step => step.status === 'failed') || steps.at(-1)
  const secondary = count > 1 && !running && steps.findLast(step => step.name !== primary?.name)
  return { count, failed, primary, secondary, running: Boolean(running) }
}

/** Keep adjacent calls on one disclosure row at their original place in the reply. */
function TurnProcess({ entries, sessionId, active, elapsedMs, lastUserIndex, streamingMessageIndex }: Props) {
  const language = useAppStore(state => state.language)
  const zh = language === 'zh'
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const { count, failed, primary, secondary, running } = useMemo(() => summarizeActivity(entries, language, active), [entries, language, active])
  const hasThinking = count === 0 && entries.some(({ message }) => Boolean(message.thinking))
  if (!primary && !hasThinking && !entries.some(({ message }) => message.toolCall)) return null

  const brand = primary && toolBrandForCall(primary.call)
  const toolName = primary?.call.tool.toLowerCase() ?? ''
  const Icon = failed && !running ? CircleAlert : hasThinking ? Brain :
    count === 1 && toolName === 'bash' ? SquareTerminal :
      count === 1 && /search|^(grep|glob|find)$/.test(toolName) ? Search : ListChecks
  const title = primary ? [primary.name, secondary && secondary.name].filter(Boolean).join(zh ? '、' : ', ')
    : hasThinking ? (zh ? '思考记录' : 'Thinking details') : (zh ? '执行详情' : 'Activity details')
  const status = primary?.status === 'running' && !active ? (zh ? '无执行结果' : 'No result') : primary?.statusLabel

  return <section className="min-w-0" aria-label={zh ? '本轮执行过程' : 'Turn activity'}>
    <button type="button" data-turn-activity-row aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}
      className="focus-ring inline-flex min-h-8 max-w-full items-start gap-2 rounded-md py-1.5 text-left text-[13px] leading-5 text-cream-dim transition-colors hover:text-cream">
      {running ? <Loader2 size={15} className="mt-0.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> :
        brand && !failed ? <BrandIcon brand={brand} size={15} className="mt-0.5" /> :
          <Icon size={15} className={`mt-0.5 shrink-0 ${failed ? 'text-red-600 dark:text-red-300' : ''}`} aria-hidden="true" />}
      <span className="min-w-0 break-words">
        <span>{title}</span>
        {(count === 1 || running) && status && <span> · {status}</span>}
        {count > 1 && <span> · {zh ? `${count} 步` : `${count} steps`}</span>}
        {failed > 0 && count > 1 && <span className="text-red-600 dark:text-red-300"> · {zh ? `${failed} 项失败` : `${failed} failed`}</span>}
        {elapsedMs !== undefined && <span className="tabular-nums"> · {formatSeconds(elapsedMs)}s</span>}
      </span>
      <ChevronDown size={13} className={`mt-1 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    <div id={id} hidden={!expanded} data-turn-activity-details className="ml-[7px] mt-1 space-y-2 border-l border-line pl-3">
      {expanded && entries.map(({ message, index }) => <div key={message.id} data-message-id={message.id} className="min-w-0">
        {message.toolCall ? <ToolCallCard toolCall={message.toolCall} active={active} /> : <MessageItem message={message} index={index} lastUserIndex={lastUserIndex}
          sessionId={sessionId} streaming={index === streamingMessageIndex} allowThinkingAutoExpand={false} showReplyActions={false} />}
      </div>)}
    </div>
  </section>
}

export default memo(TurnProcess, (before, after) => before.sessionId === after.sessionId && before.active === after.active &&
  before.elapsedMs === after.elapsedMs && before.lastUserIndex === after.lastUserIndex && before.streamingMessageIndex === after.streamingMessageIndex &&
  before.entries.length === after.entries.length && before.entries.every((entry, index) => entry.index === after.entries[index].index && entry.message === after.entries[index].message))
