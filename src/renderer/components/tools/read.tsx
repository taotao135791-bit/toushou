import { useT } from '../../i18n'
import GenericToolContent from './generic'
import RetainedOutput from './RetainedOutput'
import { ToolContentProps, toolInputObject, toolOutputText } from './index'

/** read: path + output line count, with the file content below (retained if large). */
export default function ReadToolContent({ toolCall }: ToolContentProps) {
  const t = useT()
  const path = toolInputObject(toolCall.input).path
  if (typeof path !== 'string') return <GenericToolContent toolCall={toolCall} />
  const text = toolOutputText(toolCall.output)
  const lineCount = text ? text.replace(/\n$/, '').split('\n').length : 0
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-cream/80">{path}</span>
        {text !== null && (
          <span className="shrink-0 font-mono text-[11px] text-cream-faint">
            {t('tool.lines', { count: lineCount })}
          </span>
        )}
      </div>
      {text !== null && (
        <RetainedOutput
          text={text}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-800 p-3 font-mono text-[12px] leading-5 text-cream/80"
        />
      )}
    </div>
  )
}
