import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { headTailLines, headTailChars, isLargeText } from '../../lib/retention'
import { useT } from '../../i18n'

const HEAD_LINES = 100
const TAIL_LINES = 30
const HEAD_CHARS = 20_000
const TAIL_CHARS = 10_000
/** Above this many lines, output is retained by line. */
const LINE_THRESHOLD = 200
/** Above this many characters, output is retained by size (single huge line). */
const CHAR_THRESHOLD = 100_000

interface RetainedOutputProps {
  text: string
  /** Monospace container classes for the <pre> body. */
  className?: string
}

/**
 * Large-output presentation: small outputs render in full; large ones render
 * head + hidden-count + tail by default, with a keyboard-reachable expand/collapse
 * to the full text. "Large" is line-count OR character-count, so a 4 MB minified
 * JSON on a single line is retained too — not just multi-line outputs.
 */
export default function RetainedOutput({ text, className = '' }: RetainedOutputProps) {
  const [expanded, setExpanded] = useState(false)
  const t = useT()
  const lineCount = text ? text.replace(/\n$/, '').split('\n').length : 0
  const large = isLargeText(text, LINE_THRESHOLD, CHAR_THRESHOLD)

  if (!large) {
    return <pre className={className}>{text}</pre>
  }

  // Line-based when many lines; char-based when one enormous line.
  const retained = lineCount > LINE_THRESHOLD
    ? headTailLines(text, HEAD_LINES, TAIL_LINES)
    : headTailChars(text, HEAD_CHARS, TAIL_CHARS)
  const notice =
    retained.hiddenUnit === 'lines'
      ? t('tool.hiddenLines', { count: retained.hidden.toLocaleString() })
      : t('tool.hiddenChars', { count: retained.hidden.toLocaleString() })

  return (
    <div>
      {expanded ? (
        <pre className={className}>{text}</pre>
      ) : (
        <pre className={className}>
          {retained.head}
          {'\n'}
          <span className="select-none text-cream-faint">{notice}</span>
          {'\n'}
          {retained.tail}
        </pre>
      )}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-cream-faint transition-colors hover:bg-overlay hover:text-cream"
        aria-expanded={expanded}
      >
        {expanded ? (
          <>
            <ChevronUp size={12} /> {t('tool.collapse')}
          </>
        ) : (
          <>
            <ChevronDown size={12} />{' '}
            {retained.hiddenUnit === 'lines'
              ? t('tool.showFullOutput', { lines: lineCount })
              : t('tool.showFullOutputChars', { chars: text.length.toLocaleString() })}
          </>
        )}
      </button>
    </div>
  )
}

