import { ComponentPropsWithoutRef, ReactElement, ReactNode, isValidElement, memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { useT } from '../i18n'
import { richRenderers } from '../lib/richRenderers'

interface CodeChildProps {
  className?: string
  children?: ReactNode
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const t = useT()

  const { lang, raw } = extractCode(children)

  const copy = () => {
    navigator.clipboard.writeText(raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-800">
      <div className="flex items-center justify-between border-b border-line bg-overlay px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-cream-faint">
          {lang || 'code'}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
        >
          {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[13px] leading-6 text-cream/90">
        <code>{raw}</code>
      </pre>
    </div>
  )
}

/**
 * Markdown is runtime-provided content. Keep every link inside the explicit,
 * Main-validated external-browser path rather than allowing renderer anchors
 * to navigate the Electron application window.
 */
function ExternalLink({ href, onClick, ...props }: ComponentPropsWithoutRef<'a'>) {
  const openInBrowser: ComponentPropsWithoutRef<'a'>['onClick'] = (event) => {
    onClick?.(event)
    if (event.defaultPrevented) return

    event.preventDefault()
    if (href) {
      // Main validates the scheme/host before delegating to the system browser.
      // Deliberately ignore invalid URLs here: they must not turn into an app
      // navigation fallback.
      void window.electronAPI.openExternalUrl(href)
    }
  }

  return <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={openInBrowser} />
}

/** Lang and raw text of a fenced code block, from the <code> child of a <pre>. */
function extractCode(children: ReactNode): { lang: string; raw: string } {
  if (!isValidElement<CodeChildProps>(children)) return { lang: '', raw: '' }
  const child = children as ReactElement<CodeChildProps>
  return {
    lang: /language-([\w-]+)/.exec(child.props.className || '')?.[1] || '',
    raw: String(child.props.children ?? '').replace(/\n$/, '')
  }
}

const remarkPlugins = [remarkGfm]

const components = {
  a: ExternalLink,
  pre: ({ children }: { children?: ReactNode }) => {
    const { lang, raw } = extractCode(children)
    // Rich blocks (mermaid, …) by fence language; unknown → CodeBlock
    const Renderer = raw.trim() ? richRenderers[lang] : undefined
    if (Renderer) return <Renderer raw={raw} />
    return <CodeBlock>{children}</CodeBlock>
  }
}

/** Minimum spacing between full markdown parses while a reply is streaming. */
const STREAM_PARSE_INTERVAL_MS = 120

/**
 * Memoized on `content`: during streaming only the in-flight message's
 * string changes, so every historical message skips re-parsing its markdown.
 *
 * Appending deltas are additionally SAMPLED at STREAM_PARSE_INTERVAL_MS:
 * react-markdown reparses the whole string per update, so per-32ms-batch
 * appends cost O(n²) over a long reply. Non-append changes (edits, rollbacks)
 * always render immediately, and the trailing timer guarantees the final
 * content lands.
 */
const Markdown = memo(function Markdown({ content }: { content: string }) {
  const [rendered, setRendered] = useState(content)
  const parseClock = useRef({ at: 0, timer: null as ReturnType<typeof setTimeout> | null })

  useEffect(() => {
    const clock = parseClock.current
    const isAppend = content.startsWith(rendered) && content.length > rendered.length
    if (isAppend) {
      const since = Date.now() - clock.at
      if (since < STREAM_PARSE_INTERVAL_MS) {
        if (clock.timer) clearTimeout(clock.timer)
        clock.timer = setTimeout(
          () => {
            clock.timer = null
            clock.at = Date.now()
            setRendered(content)
          },
          STREAM_PARSE_INTERVAL_MS - since
        )
        return () => {
          if (clock.timer) {
            clearTimeout(clock.timer)
            clock.timer = null
          }
        }
      }
    }
    if (clock.timer) {
      clearTimeout(clock.timer)
      clock.timer = null
    }
    clock.at = Date.now()
    setRendered(content)
  }, [content])

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {rendered}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
