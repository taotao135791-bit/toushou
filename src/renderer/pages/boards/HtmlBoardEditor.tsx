import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { htmlBoardTemplate, renderHtmlBoard, type HtmlBoardDocument, type HtmlBoardDocumentResult, type HtmlBoardExportInput, type HtmlBoardExportResult, type HtmlBoardLanguage, type HtmlBoardSaveInput, type HtmlBoardTemplate } from '@shared/htmlBoard'
import { useModalBoundary } from '../../lib/modalBoundary'

export interface HtmlBoardEditorProps {
  document: HtmlBoardDocument
  language?: HtmlBoardLanguage
  onSave: (input: HtmlBoardSaveInput) => Promise<HtmlBoardDocumentResult>
  onExport: (input: HtmlBoardExportInput) => Promise<HtmlBoardExportResult>
  onClose: () => void
}

/** Edit display content around a protected, immutable reading snapshot. */
export function HtmlBoardEditor({ document: initial, language = 'zh', onSave, onExport, onClose }: HtmlBoardEditorProps) {
  const zh = language !== 'en'
  const root = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState(initial)
  const [html, setHtml] = useState(initial.html)
  const [css, setCss] = useState(initial.css)
  const [theme, setTheme] = useState<HtmlBoardTemplate>(initial.theme ?? 'editorial')
  const [anonymous, setAnonymous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<HtmlBoardTemplate | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const dirty = html !== saved.html || css !== saved.css || theme !== (saved.theme ?? 'editorial')
  const close = () => { if (!busy) dirty ? setConfirmClose(true) : onClose() }
  useModalBoundary(root, true, close)
  const preview = useMemo(() => {
    try { return { html: renderHtmlBoard({ ...saved, html, css, theme }, { anonymize: anonymous, language }), error: null } }
    catch { return { html: null, error: zh ? '预览失败：保留一个顶层数据占位符，移除脚本、外链、样式属性和不支持的 CSS 后重试。' : 'Cannot preview: keep one top-level data slot and remove scripts, external links, inline styles, and unsupported CSS.' } }
  }, [saved, html, css, theme, anonymous, language, zh])
  const applyTemplate = (id: HtmlBoardTemplate) => {
    const next = htmlBoardTemplate(id, language)
    setHtml(next.html); setCss(next.css); setTheme(id); setPendingTemplate(null); setNotice(null)
  }
  const save = async () => {
    if (busy || !dirty || !preview.html) return
    setBusy(true); setNotice(null)
    try {
      const result = await onSave({ id: saved.id, expectedRevision: saved.revision, html, css, theme })
      if (result.ok) { setSaved(result.document); setHtml(result.document.html); setCss(result.document.css); setTheme(result.document.theme ?? 'editorial'); setNotice(zh ? '已保存。' : 'Saved.') }
      else setNotice(result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，请关闭后重新打开并检查未保存内容。' : 'This board changed in another window. Reopen it and review your unsaved changes.') : (zh ? '保存失败，请检查内容后重试。' : 'Save failed. Check the content and try again.'))
    } catch { setNotice(zh ? '保存失败，请重试。' : 'Save failed. Try again.') }
    finally { setBusy(false) }
  }
  const exportFile = async () => {
    if (busy || dirty || !preview.html) return
    setBusy(true); setNotice(null)
    try {
      const result = await onExport({ id: saved.id, expectedRevision: saved.revision, anonymize: anonymous, language })
      if (result.ok) setNotice(zh ? '已导出离线 HTML 文件。' : 'Offline HTML exported.')
      else if (result.error !== 'cancelled') setNotice(result.error === 'conflict' ? (zh ? '看板已在其他窗口更改，请重新打开。' : 'This board changed in another window. Reopen it.') : (zh ? '导出失败，请重试。' : 'Export failed. Try again.'))
    } catch { setNotice(zh ? '导出失败，请重试。' : 'Export failed. Try again.') }
    finally { setBusy(false) }
  }
  const names: Record<HtmlBoardTemplate, string> = { editorial: zh ? '周报' : 'Editorial', operations: zh ? '巡检' : 'Operations', minimal: zh ? '简约' : 'Minimal' }
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby="html-board-editor-title" tabIndex={-1} className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4"><div><h2 id="html-board-editor-title" className="text-[16px] font-semibold text-cream">{zh ? '自定义 HTML 读数看板' : 'Customize HTML reading board'}</h2><p className="text-[12px] text-cream-faint">{zh ? '静态快照；样式和文字可编辑，原始读数不可改写。' : 'Static snapshot; edit text and style without changing the source readings.'}</p></div><button type="button" onClick={close} disabled={busy} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{zh ? '关闭' : 'Close'}</button></header>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2">
        <section className="min-w-0 space-y-3"><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] text-cream-faint">{zh ? '读数区样式' : 'Report style'}</span>{(Object.keys(names) as HtmlBoardTemplate[]).map(id => <button key={id} type="button" aria-pressed={theme === id} disabled={busy} onClick={() => { setTheme(id); setNotice(null) }} className={`focus-ring rounded-full border px-3 py-1 text-[12px] text-cream-dim disabled:opacity-40 ${theme === id ? 'border-accent bg-accent-soft' : 'border-line'}`}>{names[id]}</button>)}</div><p className="text-[12px] text-cream-faint">{zh ? '切换读数区配色和字体，不改变数据或自定义内容。' : 'Change report colors and typography without altering data or custom content.'}</p><div className="flex flex-wrap items-center gap-2"><span className="text-[12px] text-cream-faint">{zh ? '应用布局模板' : 'Apply layout template'}</span>{(Object.keys(names) as HtmlBoardTemplate[]).map(id => <button key={id} type="button" disabled={busy} onClick={() => dirty ? setPendingTemplate(id) : applyTemplate(id)} className="focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-cream-dim disabled:opacity-40">{names[id]}</button>)}</div>
          {pendingTemplate && <div role="alert" className="rounded-lg border border-amber-500/40 p-2 text-[12px] text-cream"><p>{zh ? '应用模板会替换当前未保存的 HTML 和 CSS。' : 'Applying a template replaces your unsaved HTML and CSS.'}</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => applyTemplate(pendingTemplate)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '替换' : 'Replace'}</button><button type="button" onClick={() => setPendingTemplate(null)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '取消' : 'Cancel'}</button></div></div>}
          <p className="text-[12px] leading-5 text-cream-faint">{zh ? '保留一个顶层 <div data-reading-slot></div>。允许常用 HTML 标签、类名和受限 CSS；不支持脚本、链接、图片或外部资源。自定义 HTML/CSS 的文本、属性和注释不会自动脱敏。' : 'Keep one top-level <div data-reading-slot></div>. Common HTML and scoped CSS are supported; scripts, links, images and external resources are not. Custom HTML/CSS text, attributes and comments are not automatically anonymized.'}</p>
          <label className="block text-[12px] text-cream-dim">HTML<textarea aria-label="HTML" spellCheck={false} value={html} onChange={event => { setHtml(event.target.value); setNotice(null) }} disabled={busy} className="mt-1 min-h-48 w-full rounded-lg border border-line bg-ink-900 p-3 font-mono text-[12px] text-cream" /></label>
          <label className="block text-[12px] text-cream-dim">CSS<textarea aria-label="CSS" spellCheck={false} value={css} onChange={event => { setCss(event.target.value); setNotice(null) }} disabled={busy} className="mt-1 min-h-40 w-full rounded-lg border border-line bg-ink-900 p-3 font-mono text-[12px] text-cream" /></label>
        </section>
        <section className="flex min-h-[360px] min-w-0 flex-col gap-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-medium text-cream">{zh ? '离线预览' : 'Offline preview'}</h3><label className="flex items-center gap-2 text-[12px] text-cream-dim"><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} disabled={busy} />{zh ? '脱敏账户数据' : 'Anonymize account data'}</label></div><p className="text-[12px] text-cream-faint">{zh ? '账户名和 ID 默认脱敏；请检查自定义 HTML/CSS 的文本、属性、注释及数值后分享。' : 'Account names and IDs are anonymized by default. Review your custom HTML/CSS text, attributes, comments, and values before sharing.'}</p>{preview.html ? <iframe title={zh ? '自定义看板预览' : 'Custom board preview'} sandbox="" srcDoc={preview.html} className="min-h-[360px] w-full flex-1 rounded-lg border border-line bg-white" /> : <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-[12px] text-red-500">{preview.error}</p>}</section>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3"><div className="text-[12px] text-cream-faint" role="status">{notice ?? (dirty ? (zh ? '有未保存的修改；保存后才能导出。' : 'Unsaved changes; save before exporting.') : (zh ? '导出的是本地静态文件，不会自动刷新或生成分享链接。' : 'Export is a local static file; it does not refresh or create a share link.'))}</div><div className="flex gap-2"><button type="button" onClick={() => void save()} disabled={busy || !dirty || !preview.html} className="focus-ring rounded-full border border-line px-3 py-1.5 text-[12px] text-cream disabled:opacity-40">{zh ? '保存' : 'Save'}</button><button type="button" onClick={() => void exportFile()} disabled={busy || dirty || !preview.html} className="focus-ring rounded-full bg-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-40">{zh ? '导出 HTML' : 'Export HTML'}</button></div></footer>
      {confirmClose && <div role="alert" className="border-t border-amber-500/40 p-3 text-[12px] text-cream"><p>{zh ? '有未保存的修改，关闭会丢失这些修改。' : 'Closing will discard your unsaved changes.'}</p><div className="mt-2 flex gap-2"><button type="button" onClick={onClose} className="focus-ring rounded border border-line px-2 py-1">{zh ? '放弃并关闭' : 'Discard and close'}</button><button type="button" onClick={() => setConfirmClose(false)} className="focus-ring rounded border border-line px-2 py-1">{zh ? '继续编辑' : 'Keep editing'}</button></div></div>}
    </div>
  </div>, globalThis.document.body)
}
