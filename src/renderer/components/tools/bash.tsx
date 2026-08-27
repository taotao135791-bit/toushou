import GenericToolContent from './generic'
import RetainedOutput from './RetainedOutput'
import { ToolContentProps, toolInputObject, toolOutputText } from './index'

// Always-dark terminal panel, in both themes — a terminal looks like a terminal.
const TERMINAL = 'rounded-lg bg-[#181715] p-3 font-mono text-[12px] leading-5'

/** bash: the command over its output, as one dark terminal-style panel. */
export default function BashToolContent({ toolCall }: ToolContentProps) {
  const command = toolInputObject(toolCall.input).command
  if (typeof command !== 'string') return <GenericToolContent toolCall={toolCall} />
  const output = toolOutputText(toolCall.output)
  return (
    <div className={`max-h-64 overflow-auto ${TERMINAL}`}>
      <div className="whitespace-pre-wrap break-words text-[#ece8e3]">
        <span className="select-none text-[#7d7870]">$ </span>
        {command}
      </div>
      {output !== null && (
        <div className="mt-2 whitespace-pre-wrap break-words border-t border-white/10 pt-2 text-[#b3aea6]">
          <RetainedOutput text={output} />
        </div>
      )}
    </div>
  )
}
