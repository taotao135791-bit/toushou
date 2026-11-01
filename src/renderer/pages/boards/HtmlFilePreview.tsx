import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalBoundary } from '../../lib/modalBoundary'

/** Show an existing workspace HTML file in the same isolated sandbox at either size. */
export function HtmlFilePreview({ html, title, language, allowScripts = true, compact = false, toolbarActions }: { html: string; title: string; language: 'zh' | 'en'; allowScripts?: boolean; compact?: boolean; toolbarActions?: ReactNode }) {
  const zh = language === 'zh'
  const [expanded, setExpanded] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalBoundary(dialogRef, expanded, () => setExpanded(false))
  const frame = (full: boolean) => <iframe title={full ? (zh ? `${title}完整预览` : `${title} full preview`) : `${title} preview`} srcDoc={html} sandbox={allowScripts ? 'allow-scripts' : ''} className="h-full min-h-0 w-full rounded border-0 bg-white" />
  const dialog = expanded && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={zh ? `${title}完整预览` : `${title} full preview`} tabIndex={-1} className="flex h-[calc(100vh-1.5rem)] w-full max-w-[1440px] flex-col overflow-hidden rounded-xl border border-line bg-ink-850 shadow-card">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3"><span className="truncate text-[13px] font-semibold text-cream">{title}</span><button type="button" onClick={() => setExpanded(false)} className="focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-cream">{zh ? '关闭' : 'Close'}</button></header>
      <div className="min-h-0 flex-1 p-3">{frame(true)}</div>
    </div>
  </div>
  return <div className="flex h-full min-h-0 flex-col gap-1"><div className={`flex shrink-0 flex-wrap items-center gap-1 text-[11px] text-cream-faint ${compact ? 'justify-start' : 'justify-between'}`}>{!compact && <span>{zh ? '内容可在预览内滚动' : 'Scroll inside the preview'}</span>}{toolbarActions}<button type="button" onClick={() => setExpanded(true)} className="focus-ring rounded-full border border-line px-2 py-1 text-cream-dim">{zh ? '展开查看' : 'Open full preview'}</button></div><div className="min-h-0 flex-1">{!expanded && frame(false)}</div>{expanded && (typeof document === 'undefined' ? dialog : createPortal(dialog, document.body))}</div>
}
