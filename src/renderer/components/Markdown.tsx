import { createContext, useContext, ComponentPropsWithoutRef, ReactElement, ReactNode, isValidElement, memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown'
import { chatAttachment } from '@shared/chatAttachment'
import { AttachmentCard, AttachmentMention } from './ChatAttachment'
import { groupReplyAttachments, isInlineFilePath } from './replyAttachments'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { useT } from '../i18n'
import { useAppStore } from '../store'
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

const InMarkdownLink = createContext(false)

function linkLabel(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(linkLabel).join('')
  if (isValidElement<{ children?: ReactNode; alt?: string }>(children)) {
    return children.props.alt || linkLabel(children.props.children)
  }
  return ''
}

function BrowserLink({ href, children, title }: ComponentPropsWithoutRef<'a'>) {
  return <a href={href} title={title} target="_blank" rel="noopener noreferrer" onClick={event => {
    event.preventDefault()
    if (href) void window.electronAPI.openExternalUrl(href)
  }}><InMarkdownLink.Provider value>{children}</InMarkdownLink.Provider></a>
}

function ExternalLink({ href, children, title }: ComponentPropsWithoutRef<'a'>) {
  if (href && chatAttachment(href)) return <AttachmentCard target={href} label={linkLabel(children) || undefined} />
  return <BrowserLink href={href} title={title}>{children}</BrowserLink>
}

function MarkdownImage({ src, alt = '', title, replyAttachments }: ComponentPropsWithoutRef<'img'> & { replyAttachments?: boolean }) {
  const inLink = useContext(InMarkdownLink)
  const [failed, setFailed] = useState<string>()
  const t = useT()
  if (!src) return <span>{alt}</span>
  const file = chatAttachment(src)
  // Local files use the host opener. A Markdown image pointing to an MP4
  // (common in imported transcripts) can also be opened through its card.
  if (file && (!file.remote || file.kind !== 'photo' || failed === src)) {
    if (inLink) return <span>{alt || file.name}</span>
    return replyAttachments ? <AttachmentMention target={src} label={alt} /> : <AttachmentCard target={src} label={alt} />
  }
  if (!file && !/^https?:\/\//i.test(src)) return <span>{alt}</span>
  if (failed === src) {
    return !inLink && /^https?:\/\//i.test(src)
      ? <ExternalLink href={src}>{alt || t('browser.openExternal')}</ExternalLink>
      : <span>{alt}</span>
  }
  const preview = <img src={src} alt={alt} title={title} loading="lazy" onError={() => setFailed(src)} />
  return inLink ? preview : <BrowserLink href={src} title={title || alt || t('browser.openExternal')}>{preview}</BrowserLink>
}

function InlineCode({ children, className }: ComponentPropsWithoutRef<'code'>) {
  const inLink = useContext(InMarkdownLink)
  const path = typeof children === 'string' ? children.trim() : ''
  if (!inLink && isInlineFilePath(path) && chatAttachment(path)) return <AttachmentCard target={path} />
  return <code className={className}>{children}</code>
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
  img: MarkdownImage,
  code: InlineCode,
  pre: ({ children }: { children?: ReactNode }) => {
    const { lang, raw } = extractCode(children)
    // Rich blocks (mermaid, …) by fence language; unknown → CodeBlock
    const Renderer = raw.trim() ? richRenderers[lang] : undefined
    if (Renderer) return <Renderer raw={raw} />
    // Model-authored markup is never executed. Keep it available for review
    // without letting code dominate the conversation's visual result.
    if (lang.toLowerCase() === 'html') return <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-[12px] text-cream-dim">HTML · <span>高级详情 / Advanced details</span></summary><div className="mt-2"><CodeBlock>{children}</CodeBlock></div></details>
    return <CodeBlock>{children}</CodeBlock>
  }
}

function ReplyAttachmentList({ children }: { children?: ReactNode }) {
  const label = useAppStore(s => s.language === 'zh' ? '附件' : 'Attachments')
  return <ul aria-label={label} className="chat-attachment-list">{children}</ul>
}

const replyComponents = {
  ...components,
  a: BrowserLink,
  code: 'code' as const,
  img: (props: ComponentPropsWithoutRef<'img'>) => <MarkdownImage {...props} replyAttachments />,
  'reply-attachment-mention': (props: ComponentPropsWithoutRef<typeof AttachmentMention>) =>
    <InMarkdownLink.Provider value><AttachmentMention {...props} /></InMarkdownLink.Provider>,
  'reply-attachment-card': AttachmentCard,
  'reply-attachment-list': ReplyAttachmentList
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
const Markdown = memo(function Markdown({ content, replyAttachments = false }: { content: string; replyAttachments?: boolean }) {
  const id = useId()
  const rehypePlugins = useMemo<Options['rehypePlugins']>(
    () => replyAttachments ? [[groupReplyAttachments, 'reply-file-' + id]] : undefined, [replyAttachments, id]
  )
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
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
        components={replyAttachments ? replyComponents : components} urlTransform={url => chatAttachment(url) ? url : defaultUrlTransform(url)}>
        {rendered}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
