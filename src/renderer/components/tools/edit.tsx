import { diffLineClass } from '../ChangesPanel'
import GenericToolContent from './generic'
import { ToolContentProps, toolInputObject, toolOutputText } from './index'

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Lines of a text, ignoring one trailing newline (no phantom empty line). */
function linesOf(text: string): string[] {
  return text.replace(/\n$/, '').split('\n')
}

/**
 * edit/write: path + a +added/−removed summary; an edit with oldText/newText
 * renders as a simple −/+ block (same line styles as the changes panel),
 * a write shows the new content.
 */
export default function EditToolContent({ toolCall }: ToolContentProps) {
  const obj = toolInputObject(toolCall.input)
  const path = asText(obj.path)
  const oldText = asText(obj.oldText)
  const newText = asText(obj.newText)
  const content = asText(obj.content)
  if (path === null && oldText === null && newText === null && content === null) {
    return <GenericToolContent toolCall={toolCall} />
  }
  const removed = oldText !== null ? linesOf(oldText) : []
  const added = newText !== null ? linesOf(newText) : content !== null ? linesOf(content) : []
  const diffLines =
    oldText !== null || newText !== null
      ? [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)]
      : []
  const output = toolOutputText(toolCall.output)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        {path !== null && (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-cream/80">{path}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          {added.length > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added.length}</span>}
          {added.length > 0 && removed.length > 0 && <span className="text-cream-faint"> / </span>}
          {removed.length > 0 && <span className="text-red-600 dark:text-red-400">-{removed.length}</span>}
        </span>
      </div>
      {diffLines.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-lg bg-ink-800 py-1 font-mono text-[12px] leading-5">
          {diffLines.map((line, i) => (
            <div key={i} className={`whitespace-pre px-3 ${diffLineClass(line)}`}>
              {line.length <= 1 ? ' ' : line}
            </div>
          ))}
        </div>
      ) : (
        content !== null && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-800 p-3 font-mono text-[12px] leading-5 text-cream/80">
            {content}
          </pre>
        )
      )}
      {toolCall.isError && output !== null && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-red-500/[0.08] p-3 font-mono text-[12px] leading-5 text-red-600 dark:text-red-300">
          {output}
        </pre>
      )}
    </div>
  )
}
