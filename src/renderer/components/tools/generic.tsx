import { useT } from '../../i18n'
import RetainedOutput from './RetainedOutput'
import { ToolContentProps, toolOutputText } from './index'

/** Serialize a value for presentation (pretty JSON); non-serializable → String. */
function serializeForPresentation(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Fallback renderer: the raw input/output JSON, for tools without a custom view. */
export default function GenericToolContent({ toolCall }: ToolContentProps) {
  const t = useT()
  const input = serializeForPresentation(toolCall.input)
  const output = toolOutputText(toolCall.output)
  return (
    <div className="space-y-2.5">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-cream-faint">
          {t('tool.input')}
        </div>
        <RetainedOutput
          text={input}
          className="max-h-48 overflow-auto rounded-lg bg-ink-800 p-3 font-mono text-[12px] leading-5 text-cream/80"
        />
      </div>
      {output !== null && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-cream-faint">
            {t('tool.output')}
          </div>
          <RetainedOutput
            text={output}
            className="max-h-48 overflow-auto rounded-lg bg-ink-800 p-3 font-mono text-[12px] leading-5 text-cream/80"
          />
        </div>
      )}
    </div>
  )
}
