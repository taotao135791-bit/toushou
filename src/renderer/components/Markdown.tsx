import { ComponentPropsWithoutRef, ReactElement, ReactNode, isValidElement, useState } from 'react'
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

  let lang = ''
  let raw = ''
  if (isValidElement<CodeChildProps>(children)) {
    const child = children as ReactElement<CodeChildProps>
    lang = /language-(\w+)/.exec(child.props.className || '')?.[1] || ''
    raw = String(child.props.children ?? '').replace(/\n$/, '')
  }

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

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ExternalLink,
          pre: ({ children }) => {
            let lang = ''
            let raw = ''
            if (isValidElement<CodeChildProps>(children)) {
              const child = children as ReactElement<CodeChildProps>
              lang = /language-(\w+)/.exec(child.props.className || '')?.[1] || ''
              raw = String(child.props.children ?? '').replace(/\n$/, '')
            }
            // Rich blocks (mermaid, …) by fence language; unknown → CodeBlock
            const Renderer = raw.trim() ? richRenderers[lang] : undefined
            if (Renderer) return <Renderer raw={raw} />
            return <CodeBlock>{children}</CodeBlock>
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
