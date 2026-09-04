import { Check, Circle, CircleDotDashed } from 'lucide-react'
import { TodoItem, parseTodoInput } from '../../lib/todoInput'
import { useT } from '../../i18n'
import GenericToolContent from './generic'
import { ToolContentProps } from './index'

const STATE_ICON: Record<TodoItem['state'], typeof Circle> = {
  done: Check,
  in_progress: CircleDotDashed,
  pending: Circle
}

function stateClass(state: TodoItem['state']): string {
  switch (state) {
    case 'done':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'in_progress':
      return 'text-accent'
    default:
      return 'text-cream-faint/60'
  }
}

/**
 * Plan/todo tool calls render as a live checklist instead of raw JSON — the
 * task plan is the most legible progress signal a long turn can give.
 */
export default function TodoToolContent({ toolCall }: ToolContentProps) {
  const t = useT()
  const items = parseTodoInput(toolCall.input)
  if (!items) return <GenericToolContent toolCall={toolCall} />
  const done = items.filter((item) => item.state === 'done').length
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-cream/80">{t('tool.todo.count', { count: items.length })}</span>
        <span className="font-mono text-[11px] text-cream-faint">{done}/{items.length}</span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => {
          const Icon = STATE_ICON[item.state]
          return (
            <li key={i} className="flex items-start gap-2 text-[12px] leading-5">
              <Icon size={13} className={`mt-0.5 shrink-0 ${stateClass(item.state)}`} />
              <span
                className={
                  item.state === 'done'
                    ? 'text-cream-faint line-through'
                    : item.state === 'in_progress'
                      ? 'font-medium text-cream'
                      : 'text-cream-dim'
                }
              >
                {item.label}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
